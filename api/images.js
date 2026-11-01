// /api/images.js — Vercel serverless function
// Secure Pixabay image proxy with Supabase Storage caching.
//
// Flow:
//   1. Check Supabase ws_image_cache table for a fresh (<24h) entry
//   2. If hit → return cached CDN URL + attribution (no Pixabay call)
//   3. If miss → search Pixabay, score hits for relevance, pick best
//   4. Download best image → upload to Supabase Storage bucket
//   5. Store metadata in ws_image_cache
//   6. Return { url: <our CDN>, attribution: { name, profile, page } }
//
// Never returns a hotlinked Pixabay URL to the client.
// PIXABAY_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY stay server-side only.

// ─── Vocabulary context map ───────────────────────────────────────────────
// Each entry: { query: string sent to Pixabay, tags: string[] for relevance scoring }
// No duplicate keys. fish/bag conflict resolved: fish → animal, bag → context-split.
const VOCAB = {
  // ── Travel & booking ──
  hotel:       { query: 'hotel building exterior lobby',        tags: ['hotel','building','lobby','reception','accommodation'] },
  motel:       { query: 'motel sign exterior building',         tags: ['motel','hotel','sign','building','road'] },
  hostel:      { query: 'hostel dormitory beds travel',         tags: ['hostel','dormitory','beds','travel','backpacker'] },
  ticket:      { query: 'paper ticket concert event stub',      tags: ['ticket','paper','stub','entrance','event','concert'] },
  reservation: { query: 'hotel reception booking desk',         tags: ['reservation','booking','reception','desk','hotel','check'] },
  booking:     { query: 'hotel reception booking desk',         tags: ['booking','reservation','reception','desk','hotel'] },
  room:        { query: 'hotel room bed interior clean',        tags: ['room','bed','hotel','interior','bedroom','furniture'] },
  seat:        { query: 'seat chair airplane train',            tags: ['seat','chair','airplane','train','sitting','cushion'] },
  passport:    { query: 'passport travel document cover',       tags: ['passport','document','travel','cover','identity','border'] },
  suitcase:    { query: 'suitcase luggage travel packed',       tags: ['suitcase','luggage','travel','packed','bag','handle'] },
  luggage:     { query: 'luggage suitcase travel airport',      tags: ['luggage','suitcase','travel','airport','bag','trip'] },
  map:         { query: 'paper map travel unfolded',            tags: ['map','paper','travel','road','navigation','geography'] },
  check_in:    { query: 'airport check-in counter desk',        tags: ['check','in','counter','airport','desk','staff'] },

  // ── Transport ──
  bus:         { query: 'red bus public transport street',      tags: ['bus','transport','vehicle','street','public','passengers'] },
  car:         { query: 'car vehicle parked road',              tags: ['car','vehicle','road','automobile','drive','transport'] },
  train:       { query: 'train railway station platform',       tags: ['train','railway','station','platform','transport','tracks'] },
  plane:       { query: 'airplane aircraft sky flying',         tags: ['airplane','aircraft','sky','flying','flight','wing'] },
  airplane:    { query: 'airplane aircraft sky flying',         tags: ['airplane','aircraft','sky','flying','flight','wing'] },
  flight:      { query: 'airplane aircraft sky taking off',     tags: ['airplane','flight','aircraft','sky','airport','departure'] },
  boat:        { query: 'boat sea water sailing',               tags: ['boat','water','sea','sailing','vessel','ocean'] },
  ship:        { query: 'ship ocean vessel large',              tags: ['ship','ocean','vessel','large','sea','cargo'] },
  bicycle:     { query: 'bicycle bike riding road',             tags: ['bicycle','bike','riding','road','cycle','wheel'] },
  bike:        { query: 'bicycle bike riding road',             tags: ['bicycle','bike','riding','road','cycle','wheel'] },
  taxi:        { query: 'yellow taxi cab street city',          tags: ['taxi','cab','yellow','street','city','hire'] },

  // ── Places / buildings ──
  restaurant:  { query: 'restaurant interior tables chairs',    tags: ['restaurant','interior','tables','chairs','dining','food'] },
  cafe:        { query: 'cafe coffee shop interior counter',    tags: ['cafe','coffee','shop','counter','interior','bakery'] },
  school:      { query: 'school building exterior entrance',    tags: ['school','building','exterior','entrance','education','students'] },
  classroom:   { query: 'classroom desks chairs board school',  tags: ['classroom','desks','chairs','board','teacher','school'] },
  hospital:    { query: 'hospital building exterior sign',      tags: ['hospital','building','exterior','medical','sign','emergency'] },
  airport:     { query: 'airport terminal interior modern',     tags: ['airport','terminal','interior','departure','gate','travel'] },
  house:       { query: 'house residential building exterior',  tags: ['house','home','building','exterior','residential','garden'] },
  home:        { query: 'house home exterior front garden',     tags: ['home','house','exterior','garden','door','residential'] },
  shop:        { query: 'shop store retail front window',       tags: ['shop','store','retail','window','front','display'] },
  store:       { query: 'store shop retail interior shelves',   tags: ['store','shop','retail','shelves','interior','products'] },
  market:      { query: 'outdoor market stalls vegetables',     tags: ['market','stalls','outdoor','vegetables','fruit','sellers'] },
  library:     { query: 'library shelves books interior',       tags: ['library','shelves','books','interior','reading','quiet'] },
  kitchen:     { query: 'kitchen room cooking stove counter',   tags: ['kitchen','cooking','stove','counter','room','appliances'] },
  garden:      { query: 'garden flowers plants green outdoor',  tags: ['garden','flowers','plants','green','outdoor','lawn'] },
  office:      { query: 'office desk workplace computer',       tags: ['office','desk','workplace','computer','chair','work'] },
  park:        { query: 'park green trees path outdoor',        tags: ['park','green','trees','path','outdoor','bench'] },
  beach:       { query: 'beach sand sea waves sunny',           tags: ['beach','sand','sea','waves','sunny','shore','ocean'] },
  mountain:    { query: 'mountain peak landscape scenic',       tags: ['mountain','peak','landscape','scenic','hiking','snow'] },
  city:        { query: 'city skyline buildings street',        tags: ['city','skyline','buildings','street','urban','traffic'] },
  town:        { query: 'town square small buildings street',   tags: ['town','square','buildings','street','small','community'] },

  // ── Food & drink ──
  apple:       { query: 'red apple fruit isolated white',       tags: ['apple','fruit','red','food','healthy','fresh'] },
  banana:      { query: 'banana fruit yellow isolated',         tags: ['banana','fruit','yellow','food','tropical','fresh'] },
  orange:      { query: 'orange citrus fruit isolated',         tags: ['orange','fruit','citrus','food','healthy','fresh'] },
  bread:       { query: 'bread loaf bakery baked',              tags: ['bread','loaf','bakery','baked','food','wheat'] },
  milk:        { query: 'milk glass bottle white drink',        tags: ['milk','glass','bottle','white','drink','dairy'] },
  water:       { query: 'glass water drink clear transparent',  tags: ['water','glass','drink','clear','transparent','fresh'] },
  coffee:      { query: 'coffee cup hot drink espresso',        tags: ['coffee','cup','hot','espresso','drink','cafe'] },
  tea:         { query: 'tea cup hot drink herbal',             tags: ['tea','cup','hot','herbal','drink','mug'] },
  egg:         { query: 'egg breakfast food cracked',           tags: ['egg','breakfast','food','shell','protein','yolk'] },
  eggs:        { query: 'eggs basket breakfast food',           tags: ['eggs','basket','breakfast','food','protein','farm'] },
  rice:        { query: 'rice bowl cooked white food',          tags: ['rice','bowl','cooked','white','food','grain'] },
  fish:        { query: 'fish animal swimming underwater',       tags: ['fish','animal','swimming','underwater','sea','aquatic'] },
  chicken:     { query: 'cooked chicken meal plate food',       tags: ['chicken','cooked','meal','plate','food','roast'] },
  pizza:       { query: 'pizza whole round italian food',       tags: ['pizza','round','italian','food','cheese','toppings'] },
  salad:       { query: 'salad bowl vegetables healthy fresh',  tags: ['salad','bowl','vegetables','healthy','fresh','green'] },
  cake:        { query: 'cake decorated sweet dessert birthday',tags: ['cake','sweet','dessert','birthday','frosting','baked'] },
  table:       { query: 'dining table wooden furniture room',   tags: ['table','dining','wooden','furniture','room','surface'] },
  chair:       { query: 'chair furniture wooden seat',          tags: ['chair','furniture','wooden','seat','sitting','legs'] },

  // ── Animals ──
  cat:         { query: 'cat kitten pet domestic cute',         tags: ['cat','kitten','pet','domestic','cute','fur'] },
  dog:         { query: 'dog puppy pet domestic cute',          tags: ['dog','puppy','pet','domestic','cute','breed'] },
  bird:        { query: 'bird colorful perched branch',         tags: ['bird','colorful','perched','branch','feathers','wings'] },
  horse:       { query: 'horse animal field running',           tags: ['horse','animal','field','running','mane','farm'] },
  cow:         { query: 'cow farm animal field grass',          tags: ['cow','farm','animal','field','grass','milk','dairy'] },
  sheep:       { query: 'sheep farm animal wool',               tags: ['sheep','farm','animal','wool','field','grass'] },
  rabbit:      { query: 'rabbit bunny pet white ears',          tags: ['rabbit','bunny','pet','ears','fur','cute'] },
  elephant:    { query: 'elephant wildlife africa large',       tags: ['elephant','wildlife','africa','large','trunk','grey'] },
  lion:        { query: 'lion wildlife africa mane',            tags: ['lion','wildlife','africa','mane','predator','big cat'] },
  goldfish:    { query: 'goldfish orange aquarium water',       tags: ['goldfish','aquarium','orange','water','tank','pet'] },

  // ── School objects ──
  pencil:      { query: 'pencil yellow stationery isolated',    tags: ['pencil','yellow','stationery','write','school','eraser'] },
  pen:         { query: 'pen ballpoint stationery writing',     tags: ['pen','ballpoint','stationery','writing','school','ink'] },
  book:        { query: 'open book pages reading',              tags: ['book','pages','reading','open','text','story'] },
  books:       { query: 'stack books library reading',          tags: ['books','stack','library','reading','knowledge','shelves'] },
  notebook:    { query: 'notebook spiral paper school',         tags: ['notebook','spiral','paper','school','writing','notes'] },
  bag:         { query: 'shopping bag plastic paper handles',   tags: ['bag','shopping','plastic','paper','handles','carry','store'] },
  backpack:    { query: 'backpack school student colorful',     tags: ['backpack','school','student','colorful','bag','zipper'] },
  schoolbag:   { query: 'school bag backpack student',          tags: ['school','bag','backpack','student','carry','zipper'] },
  computer:    { query: 'laptop computer desk modern',          tags: ['laptop','computer','desk','modern','screen','keyboard'] },
  laptop:      { query: 'laptop computer open screen',          tags: ['laptop','computer','open','screen','keyboard','work'] },
  phone:       { query: 'smartphone mobile phone modern',       tags: ['smartphone','mobile','phone','screen','modern','app'] },
  mobile:      { query: 'mobile smartphone touchscreen',        tags: ['mobile','smartphone','touchscreen','phone','screen','app'] },
  clock:       { query: 'clock wall round time',                tags: ['clock','wall','round','time','hands','hour'] },
  watch:       { query: 'wristwatch arm time elegant',          tags: ['watch','wristwatch','arm','time','elegant','strap'] },
  door:        { query: 'door wooden entrance closed',          tags: ['door','wooden','entrance','closed','handle','frame'] },
  window:      { query: 'window glass light clear view',        tags: ['window','glass','light','clear','view','frame'] },

  // ── People / roles ──
  teacher:     { query: 'teacher classroom whiteboard students',tags: ['teacher','classroom','whiteboard','students','education','teaching'] },
  doctor:      { query: 'doctor medical white coat stethoscope',tags: ['doctor','medical','coat','stethoscope','health','hospital'] },
  student:     { query: 'student studying desk reading book',   tags: ['student','studying','desk','reading','book','school'] },
  family:      { query: 'family parents children happy together',tags: ['family','parents','children','happy','together','love'] },
  children:    { query: 'children playing happy outdoor',       tags: ['children','playing','happy','outdoor','kids','fun'] },
  child:       { query: 'child playing happy smiling',          tags: ['child','playing','happy','smiling','kid','young'] },
  baby:        { query: 'baby infant sleeping cute',            tags: ['baby','infant','sleeping','cute','newborn','small'] },
  man:         { query: 'man adult smiling portrait',           tags: ['man','adult','portrait','smiling','male','person'] },
  woman:       { query: 'woman adult smiling portrait',         tags: ['woman','adult','portrait','smiling','female','person'] },
  friend:      { query: 'friends smiling together happy',       tags: ['friends','smiling','together','happy','group','young'] },
  friends:     { query: 'friends smiling together happy',       tags: ['friends','smiling','together','happy','group','young'] },
};

// ─── Relevance scorer ────────────────────────────────────────────────────
// Score a Pixabay hit against target tags. Returns 0–100.
function scoreHit(hit, targetTags) {
  const hitTags = (hit.tags || '').toLowerCase().split(',').map(t => t.trim());
  const hitType = (hit.type || '').toLowerCase();
  let score = 0;

  // Tag overlap (primary signal)
  for (const tag of targetTags) {
    if (hitTags.some(ht => ht.includes(tag) || tag.includes(ht))) score += 10;
  }

  // Prefer photos over illustrations/vectors
  if (hitType === 'photo') score += 5;

  // Prefer landscape orientation (better for worksheet inline)
  if (hit.imageWidth > hit.imageHeight) score += 3;

  // Prefer higher resolution (better print quality)
  if (hit.imageWidth >= 1280) score += 4;
  else if (hit.imageWidth >= 640) score += 2;

  // Penalise hits with many unrelated tags (noisy results)
  if (hitTags.length > 8) score -= 2;

  return score;
}

// ─── Supabase helpers (raw fetch, no SDK) ────────────────────────────────
function sbHeaders(key) {
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function cacheGet(supabaseUrl, serviceKey, word) {
  const url = `${supabaseUrl}/rest/v1/ws_image_cache?word=eq.${encodeURIComponent(word)}&select=*&limit=1`;
  const r = await fetch(url, { headers: sbHeaders(serviceKey) });
  if (!r.ok) return null;
  const rows = await r.json();
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  // Check 24h TTL
  const age = Date.now() - new Date(row.cached_at).getTime();
  if (age > 24 * 60 * 60 * 1000) return null; // expired
  return row;
}

async function cacheSet(supabaseUrl, serviceKey, word, data) {
  const url = `${supabaseUrl}/rest/v1/ws_image_cache`;
  const body = JSON.stringify({
    word,
    cdn_url: data.cdn_url,
    attribution_name: data.attribution_name,
    attribution_url: data.attribution_url,
    pixabay_page: data.pixabay_page,
    cached_at: new Date().toISOString(),
  });
  // Upsert
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      ...sbHeaders(serviceKey),
      'Prefer': 'resolution=merge-duplicates',
    },
    body,
  });
  return r.ok;
}

async function uploadToStorage(supabaseUrl, serviceKey, word, imageBuffer, contentType) {
  const ext = contentType.includes('png') ? 'png' : 'jpg';
  const path = `vocab/${word}.${ext}`;
  const uploadUrl = `${supabaseUrl}/storage/v1/object/worksheet-images/${path}`;
  const r = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: imageBuffer,
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Storage upload failed: ${r.status} ${err}`);
  }
  // Return public URL
  return `${supabaseUrl}/storage/v1/object/public/worksheet-images/${path}`;
}

// ─── Main handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  // ── Input validation ──
  const raw = (req.query.q || '').trim().toLowerCase();
  if (!raw || raw.length > 50 || !/^[a-z0-9 _-]+$/.test(raw)) {
    res.status(400).json({ error: 'Invalid query' }); return;
  }
  const word = raw.replace(/\s+/g, '_');

  // ── Env var validation ──
  const pixabayKey = process.env.PIXABAY_API_KEY;
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
  if (!pixabayKey)  { res.status(500).json({ error: 'Image service not configured' }); return; }
  if (!supabaseUrl || !serviceKey) { res.status(500).json({ error: 'Storage not configured' }); return; }

  // ── Check vocab map ──
  const vocab = VOCAB[word] || VOCAB[raw.replace(/\s+/g,'_')];
  if (!vocab) {
    // Word not in curated list → return no image rather than a risky bare search
    res.status(200).json({ error: 'not found' }); return;
  }

  try {
    // ── 1. Cache lookup ──
    const cached = await cacheGet(supabaseUrl, serviceKey, word);
    if (cached) {
      res.status(200).json({
        url: cached.cdn_url,
        attribution: {
          name: cached.attribution_name,
          profile: cached.attribution_url,
          page: cached.pixabay_page,
        },
        cached: true,
      });
      return;
    }

    // ── 2. Pixabay search ──
    const params = new URLSearchParams({
      key: pixabayKey,
      q: vocab.query,
      image_type: 'photo',
      orientation: 'horizontal',
      safesearch: 'true',
      per_page: '10',
      min_width: '640',
    });
    const searchRes = await fetch(`https://pixabay.com/api/?${params}`);
    if (!searchRes.ok) {
      res.status(502).json({ error: 'Upstream search error' }); return;
    }
    const searchData = await searchRes.json();

    if (!searchData.hits || searchData.hits.length === 0) {
      res.status(200).json({ error: 'not found' }); return;
    }

    // ── 3. Score hits, pick best ──
    const scored = searchData.hits
      .map(hit => ({ hit, score: scoreHit(hit, vocab.tags) }))
      .sort((a, b) => b.score - a.score);

    // Require a minimum relevance score to avoid unrelated images
    const best = scored[0];
    if (best.score < 10) {
      res.status(200).json({ error: 'not found' }); return;
    }
    const hit = best.hit;

    // ── 4. Download image from Pixabay ──
    const imgRes = await fetch(hit.webformatURL);
    if (!imgRes.ok) { res.status(502).json({ error: 'Image download failed' }); return; }
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const imageBuffer = await imgRes.arrayBuffer();

    // ── 5. Upload to Supabase Storage ──
    const cdnUrl = await uploadToStorage(supabaseUrl, serviceKey, word, imageBuffer, contentType);

    // ── 6. Write cache row ──
    await cacheSet(supabaseUrl, serviceKey, word, {
      cdn_url: cdnUrl,
      attribution_name: hit.user,
      attribution_url: `https://pixabay.com/users/${hit.user}-${hit.user_id}/`,
      pixabay_page: hit.pageURL,
    });

    // ── 7. Return result ──
    res.status(200).json({
      url: cdnUrl,
      attribution: {
        name: hit.user,
        profile: `https://pixabay.com/users/${hit.user}-${hit.user_id}/`,
        page: hit.pageURL,
      },
      cached: false,
    });

  } catch (e) {
    console.error('[images.js]', e.message);
    res.status(502).json({ error: 'Service error' });
  }
}
