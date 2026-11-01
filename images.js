// /api/images.js — Vercel serverless function
// Proxies Pixabay image search. API key stays server-side only.
// Usage: GET /api/images?q=apple
// Returns: { url, pageURL } or { error: "..." }

export default async function handler(req, res) {
  // CORS — allow same origin only
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const q = (req.query.q || '').trim();
  if (!q) { res.status(400).json({ error: 'Missing query parameter: q' }); return; }

  const key = process.env.PIXABAY_API_KEY;
  if (!key) { res.status(500).json({ error: 'Image service not configured' }); return; }

  const params = new URLSearchParams({
    key,
    q: q + ' education simple',
    image_type: 'photo',
    orientation: 'horizontal',
    safesearch: 'true',
    per_page: '5',
    min_width: '640',
    category: 'education',
  });

  try {
    const r = await fetch(`https://pixabay.com/api/?${params}`);
    if (!r.ok) { res.status(502).json({ error: 'Upstream error' }); return; }
    const data = await r.json();

    if (!data.hits || data.hits.length === 0) {
      // Try without category filter
      const params2 = new URLSearchParams({
        key,
        q: q + ' simple isolated white background',
        image_type: 'photo',
        safesearch: 'true',
        per_page: '3',
        min_width: '640',
      });
      const r2 = await fetch(`https://pixabay.com/api/?${params2}`);
      const data2 = await r2.json();
      if (!data2.hits || data2.hits.length === 0) {
        res.status(200).json({ error: 'not found' }); return;
      }
      const hit2 = data2.hits[0];
      res.status(200).json({ url: hit2.webformatURL, pageURL: hit2.pageURL });
      return;
    }

    const hit = data.hits[0];
    res.status(200).json({ url: hit.webformatURL, pageURL: hit.pageURL });
  } catch (e) {
    res.status(502).json({ error: 'Network error' });
  }
}
