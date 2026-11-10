// NIRA AI — emails the admin when a Pro request is saved. Independent of api/generate.js (no Groq, no usage logic).
// Env vars (existing): SUPABASE_URL, SUPABASE_SERVICE_KEY. New: RESEND_API_KEY. Optional: PRO_REQUEST_FROM, PRO_REQUEST_ADMIN_EMAIL.
// Flow: 1) validate the caller's Supabase access token  2) read THEIR pro_requests row with the service key  3) validate price  4) guard duplicate email  5) email the admin.
const ADMIN = process.env.PRO_REQUEST_ADMIN_EMAIL || 'info@niracademy.com';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Canonical prices — never trust what the client/DB stored
const CANONICAL = {
  intl: { price_usd: 5,      price_toman: null,   label: 'International ($5/month)' },
  iran: { price_usd: null,   price_toman: 300000, label: 'Iran (300,000 Toman/month)' },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: 'Sign in required' });
  const token = m[1];

  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !RESEND_API_KEY) return res.status(500).json({ error: 'Email not configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const id = body && body.id;
  if (!UUID.test(id || '')) return res.status(400).json({ error: 'Bad request' });

  try {
    // 1) Validate the user's token
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } });
    const user = ur.ok ? await ur.json() : null;
    if (!user || !UUID.test(user.id || '')) return res.status(401).json({ error: 'Invalid session' });

    // 2) Read the row — ownership enforced by user_id filter
    const rr = await fetch(
      `${SUPABASE_URL}/rest/v1/pro_requests?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(user.id)}&select=*`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    if (!rr.ok) return res.status(502).json({ error: 'Database error' }); // Fix #4: don't treat DB error as 404
    const rows = await rr.json();
    if (!Array.isArray(rows) || rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const row = rows[0];

    // Fix #3: validate created_at before using it
    const createdAt = row.created_at ? new Date(row.created_at).getTime() : NaN;
    if (isNaN(createdAt) || Date.now() - createdAt > 10 * 60 * 1000) {
      return res.status(409).json({ error: 'Request too old' });
    }

    // Fix #2: atomic claim — only proceed if email_sent was false (compare-and-swap)
    // This prevents duplicate emails even under concurrent requests for the same id.
    const claim = await fetch(
      `${SUPABASE_URL}/rest/v1/pro_requests?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(user.id)}&email_sent=eq.false`,
      {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ email_sent: true }),
      }
    );
    if (!claim.ok) return res.status(502).json({ error: 'Database error' });
    const claimed = await claim.json();
    if (!Array.isArray(claimed) || claimed.length === 0) {
      // Row not matched: either already sent or not owned — silently succeed (idempotent)
      return res.status(200).json({ ok: true });
    }

    // Fix #1: use canonical prices based on market, never trust stored price
    const market = row.market === 'iran' ? 'iran' : 'intl';
    const canonical = CANONICAL[market];
    const marketLabel = canonical.label;
    const planLabel = market === 'iran'
      ? `Pro — 300,000 Toman/month`
      : `Pro — $5/month`;

    // 3) Email the admin (prices come from CANONICAL, not from DB row)
    const lines = [
      ['Name', row.name], ['Email', row.email], ['Market', marketLabel], ['Plan', planLabel],
      ['Payment method', row.payment_method], ['Language', row.language], ['Current plan', row.current_plan],
      ['Message', row.message || '-'], ['Request ID', row.id], ['Status', row.status],
    ];
    const html = `<h2>New NIRA AI Pro request</h2><table cellpadding="6">${lines.map(([k, v]) => `<tr><td><b>${k}</b></td><td>${esc(v)}</td></tr>`).join('')}</table>
      <p>Activation is manual — update app_metadata.plan to "pro" in Supabase Auth.</p>`;
    const mail = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.PRO_REQUEST_FROM || 'NIRA AI <notifications@niracademy.com>',
        to: [ADMIN], reply_to: row.email,
        subject: `NIRA AI Pro request — ${row.name}`, html,
        text: lines.map(([k, v]) => `${k}: ${v}`).join('\n'),
      }),
    });
    if (!mail.ok) {
      // Resend failed — roll back email_sent so a retry is possible
      fetch(`${SUPABASE_URL}/rest/v1/pro_requests?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ email_sent: false }),
      }).catch(() => {});
      return res.status(502).json({ error: 'Email failed' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
}
