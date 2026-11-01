// /api/images.js — Vercel serverless function
// Proxies Pixabay image search. API key stays server-side only.
// Usage: GET /api/images?q=apple
// Returns: { url, pageURL } or { error: "..." }

// Curated search suffixes for common vocabulary categories
// Makes queries more specific so Pixabay returns relevant images
function buildQuery(word) {
  const w = word.toLowerCase().trim();

  // Places / buildings
  if (['hotel','motel','hostel'].includes(w)) return 'hotel building exterior';
  if (['restaurant','cafe','coffee shop'].includes(w)) return 'restaurant interior';
  if (['school','classroom'].includes(w)) return 'classroom school children';
  if (['hospital','clinic'].includes(w)) return 'hospital building';
  if (['airport'].includes(w)) return 'airport terminal';
  if (['house','home'].includes(w)) return 'house residential building';
  if (['shop','store','market'].includes(w)) return 'store shop retail';
  if (['library'].includes(w)) return 'library books shelves';
  if (['kitchen'].includes(w)) return 'kitchen room cooking';
  if (['garden'].includes(w)) return 'garden flowers plants';
  if (['office'].includes(w)) return 'office desk workplace';
  if (['park'].includes(w)) return 'park green trees outdoor';
  if (['beach'].includes(w)) return 'beach sea sand';
  if (['mountain'].includes(w)) return 'mountain landscape';
  if (['city','town'].includes(w)) return 'city street buildings';

  // Transport
  if (['bus'].includes(w)) return 'bus public transport vehicle';
  if (['car'].includes(w)) return 'car vehicle road';
  if (['train'].includes(w)) return 'train railway station';
  if (['plane','airplane','aeroplane','flight'].includes(w)) return 'airplane aircraft sky';
  if (['boat','ship'].includes(w)) return 'boat ship water';
  if (['bicycle','bike'].includes(w)) return 'bicycle bike riding';
  if (['taxi'].includes(w)) return 'taxi yellow cab';

  // Travel / booking vocabulary
  if (['ticket'].includes(w)) return 'ticket paper entrance';
  if (['reservation','booking'].includes(w)) return 'hotel reservation reception desk';
  if (['room'].includes(w)) return 'hotel room bed interior';
  if (['seat'].includes(w)) return 'seat chair sitting';
  if (['passport'].includes(w)) return 'passport travel document';
  if (['suitcase','luggage','bag'].includes(w)) return 'suitcase luggage travel';
  if (['map'].includes(w)) return 'map paper travel';

  // Food & drink
  if (['apple'].includes(w)) return 'apple fruit red isolated';
  if (['banana'].includes(w)) return 'banana fruit yellow';
  if (['orange'].includes(w)) return 'orange fruit citrus';
  if (['bread'].includes(w)) return 'bread loaf bakery';
  if (['milk'].includes(w)) return 'milk glass white drink';
  if (['water'].includes(w)) return 'water glass drink clear';
  if (['coffee'].includes(w)) return 'coffee cup hot drink';
  if (['tea'].includes(w)) return 'tea cup hot drink';
  if (['egg','eggs'].includes(w)) return 'egg breakfast food';
  if (['rice'].includes(w)) return 'rice bowl food white';
  if (['fish'].includes(w)) return 'fish food seafood';
  if (['chicken'].includes(w)) return 'chicken meal food cooked';
  if (['pizza'].includes(w)) return 'pizza food italian';
  if (['salad'].includes(w)) return 'salad vegetables healthy';
  if (['cake'].includes(w)) return 'cake sweet dessert';
  if (['table'].includes(w)) return 'dining table wooden furniture';

  // Animals
  if (['cat'].includes(w)) return 'cat kitten pet';
  if (['dog'].includes(w)) return 'dog puppy pet';
  if (['bird'].includes(w)) return 'bird flying colorful';
  if (['fish','goldfish'].includes(w)) return 'fish aquarium water';
  if (['horse'].includes(w)) return 'horse animal field';
  if (['cow'].includes(w)) return 'cow farm animal';
  if (['sheep'].includes(w)) return 'sheep farm animal';
  if (['rabbit'].includes(w)) return 'rabbit bunny pet';
  if (['elephant'].includes(w)) return 'elephant animal wildlife';
  if (['lion'].includes(w)) return 'lion animal wildlife';

  // School / classroom objects
  if (['pencil'].includes(w)) return 'pencil stationery isolated';
  if (['pen'].includes(w)) return 'pen writing stationery';
  if (['book','books'].includes(w)) return 'book reading open pages';
  if (['notebook'].includes(w)) return 'notebook paper school';
  if (['backpack','bag'].includes(w)) return 'backpack school student';
  if (['computer','laptop'].includes(w)) return 'laptop computer desk';
  if (['phone','mobile'].includes(w)) return 'smartphone mobile phone';
  if (['clock','watch'].includes(w)) return 'clock time wall';
  if (['chair'].includes(w)) return 'chair furniture seat';
  if (['door'].includes(w)) return 'door entrance wooden';
  if (['window'].includes(w)) return 'window glass building';

  // People / jobs
  if (['teacher'].includes(w)) return 'teacher classroom teaching';
  if (['doctor'].includes(w)) return 'doctor medical professional';
  if (['student'].includes(w)) return 'student studying reading';
  if (['family'].includes(w)) return 'family happy together';
  if (['children','child','kids'].includes(w)) return 'children playing happy';
  if (['baby'].includes(w)) return 'baby infant cute';
  if (['man'].includes(w)) return 'man adult male portrait';
  if (['woman'].includes(w)) return 'woman adult female portrait';

  // Default: word + isolated white background for clean result
  return w + ' isolated white background';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const q = (req.query.q || '').trim();
  if (!q) { res.status(400).json({ error: 'Missing query parameter: q' }); return; }

  const key = process.env.PIXABAY_API_KEY;
  if (!key) { res.status(500).json({ error: 'Image service not configured' }); return; }

  const search = buildQuery(q);

  const trySearch = async (query, extraParams = {}) => {
    const params = new URLSearchParams({
      key,
      q: query,
      image_type: 'photo',
      orientation: 'horizontal',
      safesearch: 'true',
      per_page: '5',
      min_width: '400',
      ...extraParams,
    });
    const r = await fetch(`https://pixabay.com/api/?${params}`);
    if (!r.ok) return null;
    const data = await r.json();
    return (data.hits && data.hits.length > 0) ? data.hits[0] : null;
  };

  try {
    // Pass 1: curated query
    let hit = await trySearch(search);

    // Pass 2: bare word, no filters
    if (!hit) hit = await trySearch(q);

    if (!hit) {
      res.status(200).json({ error: 'not found' }); return;
    }

    res.status(200).json({ url: hit.webformatURL, pageURL: hit.pageURL });
  } catch (e) {
    res.status(502).json({ error: 'Network error' });
  }
}
