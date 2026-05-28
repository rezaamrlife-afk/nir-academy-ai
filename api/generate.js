export const config = {
  api: { bodyParser: true },
};

// in-memory lock per instance (basic anti-overload)
const activeRequests = new Map();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // -------------------------
  // 🔥 Simple request fingerprint (anti spam)
  // -------------------------
  const fingerprint = req.headers['x-request-id'] || Date.now().toString();

  if (activeRequests.has(fingerprint)) {
    return res.status(429).json({ error: 'Duplicate request blocked' });
  }

  activeRequests.set(fingerprint, true);

  // cleanup after 10s
  setTimeout(() => activeRequests.delete(fingerprint), 10000);

  // -------------------------
  // Parse body
  // -------------------------
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  const messages = body?.messages;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request: messages required' });
  }

  // -------------------------
  // Auth
  // -------------------------
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let userId = null;

  try {
    const { createClient } = await import('@supabase/supabase-js');

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data?.user) userId = data.user.id;

  } catch (_) {}

  if (!userId) {
    return res.status(401).json({ error: 'Authentication failed' });
  }

  // -------------------------
  // AI Provider
  // -------------------------
  const provider = process.env.AI_PROVIDER || 'groq';

  let url, headers, payload;

  if (provider === 'groq') {
    url = 'https://api.groq.com/openai/v1/chat/completions';
    headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    };
    payload = {
      model: 'llama-3.3-70b-versatile',
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

  // -------------------------
  // Timeout protection (FIX 503)
  // -------------------------
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

    // rate limit normalization
    if (response.status === 429) {
      return res.status(503).json({
        error: 'AI busy. Please retry shortly.',
      });
    }

    return res.status(response.status).json(data);

  } catch (err) {
    clearTimeout(timeout);

    if (err.name === 'AbortError') {
      return res.status(504).json({
        error: 'Request timeout',
      });
    }

    return res.status(500).json({
      error: 'Server error',
    });
  }
}
