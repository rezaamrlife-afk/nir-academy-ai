// v3
export const config = {
  api: { bodyParser: true },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Parse body
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body || {};
  const messages = body.messages;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request: messages required' });
  }

  // Auth check
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  // Verify token via Supabase
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  let userId = null;

  if (SUPABASE_URL && SUPABASE_SERVICE) {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (!error && user) userId = user.id;
    } catch (_) {}
  }

  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  // AI call — no usage limit
  const AI_PROVIDER = process.env.AI_PROVIDER || 'groq';
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

    if (aiRes.ok) {
      const text = AI_PROVIDER === 'groq'
        ? (data.choices?.[0]?.message?.content || '')
        : (data.content?.[0]?.text || '');
      return res.status(200).json({ content: [{ type: 'text', text }] });
    } 

    return res.status(aiRes.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: 'Upstream request failed', detail: err.message });
  }
}
