import { createClient } from '@supabase/supabase-js';
 
const SUPABASE_URL     = process.env.SUPABASE_URL     || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_KEY;
 
// Hard server-side limits — never trust client values
const SERVER_MAX_TOKENS   = 2048;
const EXPLORE_DAILY_LIMIT = 8;
 
// ── Provider configuration ──
// Switch provider by setting AI_PROVIDER env var:
//   AI_PROVIDER=groq        → uses Groq (free tier, Llama 3.1)
//   AI_PROVIDER=anthropic   → uses Claude (production)
//   (default: anthropic if env var not set)
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
      model:      'llama-3.1-70b-versatile',
      max_tokens: SERVER_MAX_TOKENS,
      messages,
    }),
    parse: (data) => data.choices?.[0]?.message?.content || '',
  },
};
 
export default async function handler(req, res) {
  // ── Method guard ──
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
 
  // ── Provider selection ──
  const providerName = process.env.AI_PROVIDER || 'anthropic';
  const provider     = PROVIDERS[providerName] || PROVIDERS.anthropic;
  const apiKey       = provider.apiKey();
 
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }
 
  // ── Supabase JWT validation ──
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
 
  let userId   = null;
  let userPlan = 'explore';
 
  if (token && SUPABASE_URL && SUPABASE_SERVICE) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (!error && user) {
        userId   = user.id;
        userPlan = user.user_metadata?.plan || 'explore';
      }
    } catch (_) {}
  }
 
  // ── Block anonymous ──
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
 
  // ── Usage limit for explore plan ──
  if (userPlan === 'explore' && SUPABASE_URL && SUPABASE_SERVICE) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);
      const today    = new Date().toISOString().split('T')[0];
 
      const { data: row } = await supabase
        .from('usage_daily')
        .select('usage_count')
        .eq('user_id', userId)
        .eq('date', today)
        .maybeSingle();
 
      const currentCount = row?.usage_count || 0;
 
      if (currentCount >= EXPLORE_DAILY_LIMIT) {
        return res.status(429).json({
          error:   'daily_limit_reached',
          message: 'Daily limit reached. Upgrade to Nira Pro for unlimited access.',
          usage:   currentCount,
          limit:   EXPLORE_DAILY_LIMIT,
        });
      }
    } catch (_) {}
  }
 
  // ── Validate messages ──
  const { messages } = req.body || {};
 
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request: messages required' });
  }
 
  // ── Call AI provider ──
  try {
    const response = await fetch(provider.url, {
      method:  'POST',
      headers: provider.headers(apiKey),
      body:    JSON.stringify(provider.body(messages)),
    });
 
    const data = await response.json();
 
    // ── Normalise response → always return Anthropic-compatible format ──
    // Frontend expects: data.content[0].text
    // This ensures frontend works identically regardless of provider
    if (response.ok && providerName === 'groq') {
      const text = provider.parse(data);
      const normalized = {
        content: [{ type: 'text', text }],
      };
 
      // ── Increment usage counter ──
      if (userPlan === 'explore' && SUPABASE_URL && SUPABASE_SERVICE) {
        try {
          const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);
          const today    = new Date().toISOString().split('T')[0];
          await supabase.from('usage_daily').upsert({
            user_id:     userId,
            date:        today,
            usage_count: 1,
          }, { onConflict: 'user_id,date', ignoreDuplicates: false });
        } catch (_) {}
      }
 
      return res.status(200).json(normalized);
    }
 
    // ── Anthropic: pass through as-is (frontend already parses this format) ──
    if (response.ok && userPlan === 'explore' && SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);
        const today    = new Date().toISOString().split('T')[0];
        await supabase.from('usage_daily').upsert({
          user_id:     userId,
          date:        today,
          usage_count: 1,
        }, { onConflict: 'user_id,date', ignoreDuplicates: false });
      } catch (_) {}
    }
 
    return res.status(response.status).json(data);
 
  } catch (err) {
    return res.status(500).json({ error: 'Upstream request failed' });
  }
}
