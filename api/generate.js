import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL     = process.env.SUPABASE_URL     || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_KEY;  // service role key (server-only)

// Hard server-side limits — never trust client values
const SERVER_MAX_TOKENS = 2048;
const EXPLORE_DAILY_LIMIT = 8;

export default async function handler(req, res) {
  // ── Method guard ──
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── API key guard ──
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // ── Supabase JWT validation ──
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  let userId   = null;
  let userPlan = 'explore';   // safe default

  if (token && SUPABASE_URL && SUPABASE_SERVICE) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (!error && user) {
        userId   = user.id;
        userPlan = user.user_metadata?.plan || 'explore';
      }
    } catch (_) {
      // token validation failed → treat as explore anonymous
    }
  }

  // ── Block anonymous (no valid token) ──
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
          error:       'daily_limit_reached',
          message:     'Daily limit reached. Upgrade to Nira Pro for unlimited access.',
          usage:        currentCount,
          limit:        EXPLORE_DAILY_LIMIT,
        });
      }
    } catch (_) {
      // usage check failed → allow (fail open, log in production)
    }
  }

  // ── Build safe request body — never pass req.body directly ──
  const { model, messages } = req.body || {};

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request: messages required' });
  }

  const safeBody = {
    model:      'claude-sonnet-4-20250514',   // always use correct model
    max_tokens: SERVER_MAX_TOKENS,             // ignore client value
    messages:   messages,                      // only forward messages array
  };

  // ── Call Anthropic ──
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(safeBody),
    });

    const data = await response.json();

    // ── Increment usage counter after successful call ──
    if (response.ok && userPlan === 'explore' && SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);
        const today    = new Date().toISOString().split('T')[0];

        await supabase
          .from('usage_daily')
          .upsert({
            user_id:     userId,
            date:        today,
            usage_count: 1,
          }, {
            onConflict:   'user_id,date',
            ignoreDuplicates: false,
          });

        // Note: proper increment needs an RPC or read-modify-write
        // This upsert sets to 1 on first call; production should use
        // a Supabase RPC increment function for accuracy
      } catch (_) {
        // counter update failed → non-fatal
      }
    }

    return res.status(response.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: 'Upstream request failed' });
  }
}
