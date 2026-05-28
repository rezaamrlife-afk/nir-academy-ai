export const config = {
  api: { bodyParser: true },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body || {};

  const messages = body.messages;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request: messages required' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  let userId = null;
  let userPlan = 'explore';

  if (SUPABASE_URL && SUPABASE_SERVICE) {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (!error && user) {
        userId = user.id;
        userPlan = user.user_metadata?.plan || 'explore';
      }
    } catch (_) {}
  }

  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const EXPLORE_DAILY_LIMIT = 8;
  if (userPlan === 'explore' && SUPABASE_URL && SUPABASE_SERVICE) {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);
      const today = new Date().toISOString().split('T')[0];
      const { data: row } = await supabase
        .from('usage_daily').select('usage_count')
        .eq('user_id', userId).eq('date', today).maybeSingle();
      if ((row?.usage_count || 0) >= EXPLORE_DAILY_LIMIT) {
        return res.status(429).json({
          error: 'daily_limit_reached',
          message: 'Daily limit reached. Upgrade to Nira Pro for unlimited access.',
        });
      }
    } catch (_) {}
  }

  const AI_PROVIDER = process.env.AI_PROVIDER || 'anthropic';
  let aiUrl, aiHeaders, aiBody;

  if (AI_PROVIDER === 'groq') {
    const key = process.env.GROQ_API_KEY;
    if (!key) return res.status(500).json({ error: 'API key not configured' });
    aiUrl = 'https://api.groq.com/openai/v1/chat/completions';
    aiHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` };
    aiBody = { model: 'llama-3.3-70b-versatile', max_tokens: 2048, messages };
  } else {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(500).json({ error: 'API key not configured' });
    aiUrl = 'https://api.anthropic.com/v1/messages';
    aiHeaders = { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    aiBody = { model: 'claude-sonnet-4-20250514', max_tokens: 2048, messages };
  }

  try {
    const aiRes = await fetch(aiUrl, {
      method: 'POST',
      headers: aiHeaders,
      body: JSON.stringify(aiBody),
    });
    const data = await aiRes.json();

    if (aiRes.ok && AI_PROVIDER === 'groq') {
      const text = data.choices?.[0]?.message?.content || '';
      if (userPlan === 'explore' && SUPABASE_URL && SUPABASE_SERVICE) {
        try {
          const { createClient } = await import('@supabase/supabase-js');
          const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE);
          const today = new Date().toISOString().split('T')[0];
          const { data: existingRow } = await sb.from('usage_daily')
            .select('usage_count').eq('user_id', userId).eq('date', today).maybeSingle();
          await sb.from('usage_daily').upsert(
            { user_id: userId, date: today, usage_count: (existingRow?.usage_count || 0) + 1 },
            { onConflict: 'user_id,date', ignoreDuplicates: false }
          );
        } catch (_) {}
      }
      return res.status(200).json({ content: [{ type: 'text', text }] });
    }

    if (aiRes.ok && userPlan === 'explore' && SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE);
        const today = new Date().toISOString().split('T')[0];
        const { data: existingRow2 } = await sb.from('usage_daily')
          .select('usage_count').eq('user_id', userId).eq('date', today).maybeSingle();
        await sb.from('usage_daily').upsert(
          { user_id: userId, date: today, usage_count: (existingRow2?.usage_count || 0) + 1 },
          { onConflict: 'user_id,date', ignoreDuplicates: false }
        );
      } catch (_) {}
    }

    return res.status(aiRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Upstream request failed', detail: err.message });
  }
}
