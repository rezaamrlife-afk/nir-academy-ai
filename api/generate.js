export const config = {
  api: { bodyParser: true },
};

const activeRequests = new Map();

const FREE_LIMIT = 5;
const PRO_LIMIT  = 100;
const MAX_USAGE_ATTEMPTS = 10;

// Atomic check-and-increment using compare-and-swap on the row.
// Concurrent requests can never push the count past `limit`: each increment only
// succeeds if usage_count still equals the value we just read, otherwise we re-read.
// Throws on any database error (caller must fail closed).
async function checkAndIncrementUsage(supabase, userId, plan) {
  const today = new Date().toISOString().slice(0, 10);
  const limit = plan === 'pro' ? PRO_LIMIT : FREE_LIMIT;

  for (let attempt = 0; attempt < MAX_USAGE_ATTEMPTS; attempt++) {
    const { data: row, error: selectError } = await supabase
      .from('usage_daily')
      .select('usage_count')
      .eq('user_id', userId)
      .eq('date', today)
      .eq('tool', 'general')
      .maybeSingle();
    if (selectError) throw selectError;

    if (!row) {
      // First request today: insert. Unique (user_id,date,tool) makes racing inserts fail.
      const { error: insertError } = await supabase.from('usage_daily').insert({
        user_id: userId, date: today, tool: 'general', usage_count: 1, updated_at: new Date().toISOString(),
      });
      if (!insertError) return { allowed: true, current: 1, limit, date: today };
      if (insertError.code !== '23505') throw insertError; // not a duplicate-key race
      continue; // another request created the row first; re-read
    }

    const current = row.usage_count;
    if (current >= limit) return { allowed: false, current, limit, date: today };

    // Only increments if nobody else changed the count since we read it.
    const { data: updated, error: updateError } = await supabase
      .from('usage_daily')
      .update({ usage_count: current + 1, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('date', today)
      .eq('tool', 'general')
      .eq('usage_count', current)
      .select('usage_count');
    if (updateError) throw updateError;

    if (updated && updated.length > 0) {
      return { allowed: true, current: current + 1, limit, date: today };
    }
    // Lost the race; loop and re-read.
  }

  throw new Error('Usage counter contention');
}

// Atomic refund (same compare-and-swap approach). Never throws.
async function refundUsage(supabase, userId, date) {
  try {
    for (let attempt = 0; attempt < MAX_USAGE_ATTEMPTS; attempt++) {
      const { data: row, error: selectError } = await supabase
        .from('usage_daily')
        .select('usage_count')
        .eq('user_id', userId).eq('date', date).eq('tool', 'general')
        .maybeSingle();
      if (selectError || !row || row.usage_count <= 0) return;

      const { data: updated, error: updateError } = await supabase
        .from('usage_daily')
        .update({ usage_count: row.usage_count - 1, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('date', date).eq('tool', 'general')
        .eq('usage_count', row.usage_count)
        .select('usage_count');
      if (updateError) return;
      if (updated && updated.length > 0) return;
    }
  } catch (_) {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const fingerprint = req.headers['x-request-id'] || Date.now().toString();

  if (activeRequests.has(fingerprint)) {
    return res.status(429).json({ error: 'Duplicate request blocked' });
  }

  activeRequests.set(fingerprint, true);
  setTimeout(() => activeRequests.delete(fingerprint), 10000);

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  const messages = body?.messages;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request: messages required' });
  }

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let userId = null;
  let userPlan = 'free';
  let supabase = null;

  try {
    const { createClient } = await import('@supabase/supabase-js');
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data?.user) {
      userId = data.user.id;
      // app_metadata can only be written with the service key (server-side),
      // unlike user_metadata which any logged-in user can edit from the client.
      userPlan = data.user.app_metadata?.plan === 'pro' ? 'pro' : 'free';
    }
  } catch (_) {}

  if (!userId) {
    return res.status(401).json({ error: 'Authentication failed' });
  }

  // ── Usage limit check (before hitting AI) ──────────────────────────────────
  let usageDate = null;
  try {
    const usage = await checkAndIncrementUsage(supabase, userId, userPlan);
    if (!usage.allowed) {
      const limitLabel = userPlan === 'pro' ? PRO_LIMIT : FREE_LIMIT;
      return res.status(429).json({
        error: `Daily limit reached (${limitLabel}/day). ${userPlan === 'pro' ? 'Resets at midnight UTC.' : 'Upgrade to Pro for 100 generations/day.'}`,
      });
    }
    usageDate = usage.date;
  } catch (err) {
    // Fail closed: if usage can't be verified/recorded, don't serve the request.
    console.error('Usage check failed:', err);
    return res.status(503).json({ error: 'Usage service unavailable. Please retry shortly.' });
  }

  const provider = process.env.AI_PROVIDER || 'groq';

  let url, headers, payload;

  if (provider === 'groq') {
    url = 'https://api.groq.com/openai/v1/chat/completions';
    headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    };
    payload = {
      model: 'openai/gpt-oss-120b', // ✅ عوض شد
      max_tokens: 2048,
      messages,
    };
  } else {
    url = 'https://api.anthropic.com/v1/messages';
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    };
    payload = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await response.json();

    if (response.ok) {
      const text =
        provider === 'groq'
          ? data?.choices?.[0]?.message?.content || ''
          : data?.content?.[0]?.text || '';

      return res.status(200).json({
        content: [{ type: 'text', text }],
      });
    }

    // AI call failed — refund the usage count
    await refundUsage(supabase, userId, usageDate);

    if (response.status === 429) {
      return res.status(503).json({
        error: 'AI busy. Please retry shortly.',
      });
    }

    return res.status(response.status).json(data);

  } catch (err) {
    clearTimeout(timeout);

    // AI call failed — refund the usage count
    await refundUsage(supabase, userId, usageDate);

    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Request timeout' });
    }

    return res.status(500).json({ error: 'Server error' });
  }
}
