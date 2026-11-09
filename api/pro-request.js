// NIRA AI — emails the admin when a Pro request is saved. Independent of api/generate.js (no Groq, no usage logic).
// Env vars (existing): SUPABASE_URL, SUPABASE_SERVICE_KEY. New: RESEND_API_KEY. Optional: PRO_REQUEST_FROM, PRO_REQUEST_ADMIN_EMAIL.
// Flow: 1) validate the caller's Supabase access token  2) read THEIR pro_requests row with the service key  3) email the admin.
// The service key bypasses RLS, so ownership is enforced here (user_id = the validated user) and the key never leaves the server.
const ADMIN = process.env.PRO_REQUEST_ADMIN_EMAIL || 'info@niracademy.com';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    // 1) Validate the user's token separately (the service key is only the project apikey here)
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } });
    const user = ur.ok ? await ur.json() : null;
    if (!user || !UUID.test(user.id || '')) return res.status(401).json({ error: 'Invalid session' });

    // 2) Read the row with the service key, restricted to this user's own request
    const rr = await fetch(
      `${SUPABASE_URL}/rest/v1/pro_requests?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(user.id)}&select=*`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const rows = rr.ok ? await rr.json() : [];
    const row = rows && rows[0];
    if (!row) return res.status(404).json({ error: 'Request not found' });
    if (Date.now() - new Date(row.created_at).getTime() > 10 * 60 * 1000) return res.status(409).json({ error: 'Request too old' });

    // 3) Email the admin (content comes from the saved row, never from the client)
    const lines = [
      ['Name', row.name], ['Email', row.email], ['Plan', `Pro — $${row.price_usd}/month`], ['Payment method', row.payment_method],
      ['Language', row.language], ['Current plan', row.current_plan], ['Message', row.message || '-'], ['Request ID', row.id], ['Status', row.status],
    ];
    const html = `<h2>New NIRA AI Pro request</h2><table cellpadding="6">${lines.map(([k, v]) => `<tr><td><b>${k}</b></td><td>${esc(v)}</td></tr>`).join('')}</table>
      <p>Activation is manual — see supabase/pro_requests.sql.</p>`;
    const mail = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.PRO_REQUEST_FROM || 'NIRA AI <onboarding@resend.dev>',
        to: [ADMIN], reply_to: row.email,
        subject: `NIRA AI Pro request — ${row.name}`, html,
        text: lines.map(([k, v]) => `${k}: ${v}`).join('\n'),
      }),
    });
    if (!mail.ok) return res.status(502).json({ error: 'Email failed' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
}
