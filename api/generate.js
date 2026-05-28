import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL     = process.env.SUPABASE_URL     || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_KEY;

const SERVER_MAX_TOKENS = 2048;

const PROVIDERS = {
  anthropic: {
    url:     'https://api.anthropic.com/v1/messages',
    apiKey:  () => process.env.ANTHROPIC_API_KEY,
    headers: (key) => ({
      'Content-Type':      'application/json',
      'x-api-key':         key,
      'anthropic-version': '2023-06-01',
    }),
    body: (messages) => ({
      model:      'claude-sonnet-4-20250514',
      max_tokens: SERVER_MAX_TOKENS,
      messages,
    }),
    parse: (data) => data.content?.[0]?.text || '',
  },
  groq: {
    url:     'https://api.groq.com/openai/v1/chat/completions',
    apiKey:  () => process.env.GROQ_API_KEY,
    headers: (key) => ({
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    body: (messages) => ({
      model:      'llama-3.3-70b-versatile',
      max_tokens: SERVER_MAX_TOKENS,
      messages,
    }),
    parse: (data) => data.choices?.[0]?.message?.content || '',
  },
};

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const providerName = process.env.AI_PROVIDER || 'groq';
  const provider     = PROVIDERS[providerName] || PROVIDERS.groq;
  const apiKey       = provider.apiKey();
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  let userId = null;

  if (token && SUPABASE_URL && SUPABASE_SERVICE) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (!error && user) userId = user.id;
    } catch (_) {}
  }

  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  let messages;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    messages = body?.messages;
  } catch (_) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request: messages required' });
  }

  try {
    const response = await fetch(provider.url, {
      method:  'POST',
      headers: provider.headers(apiKey),
      body:    JSON.stringify(provider.body(messages)),
    });

    const data = await response.json();

    if (response.ok) {
      const text = provider.parse(data);
      return res.status(200).json({ content: [{ type: 'text', text }] });
    }

    return res.status(response.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: 'Upstream request failed' });
  }
}
