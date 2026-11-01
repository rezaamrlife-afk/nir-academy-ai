// /api/images.js — Vercel serverless function
// Secure Pixabay image proxy with Supabase Storage caching.
//
// Flow:
//   1. Validate request origin, method, and query parameter
//   2. Check Supabase ws_image_cache table for a fresh (<24h) entry
//   3. If cache hit → return CDN URL + attribution immediately
//   4. If cache miss → search Pixabay with curated vocabulary query
//   5. Score all hits for relevance (exact match > partial > unrelated)
//   6. Reject if best score < per-category threshold
//   7. Validate downloaded image (content-type, size, HTTP status)
//   8. Upload to Supabase Storage under a unique versioned filename
//   9. Write cache row (failures are non-fatal)
//  10. Return { url, attribution: { name, profile, page } }
//
// Never returns a hotlinked Pixabay URL to the client.
// PIXABAY_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY stay server-side only.

// ─── Allowed origin ────────────────────────────────────────────────────────
// Restrict CORS to the NIRA app origins. Add staging URL if needed.
const ALLOWED_ORIGINS = [
  'https://nira-ai.vercel.app',
  'https://niracademy.com',
  'https://www.niracademy.com',
];

// ─── Image constraints ─────────────────────────────────────────────────────
const MAX_IMAGE_BYTES   = 3 * 1024 * 1024;  // 3 MB hard cap
const MIN_IMAGE_BYTES   = 2 * 1024;          // 2 KB (reject obviously broken downloads)
const ALLOWED_MIME      = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const DOWNLOAD_TIMEOUT  = 8000;              // ms — abort slow Pixabay downloads

// ─── Vocabulary context map ───────────────────────────────────────────────
// Each entry: {
//   query    : string sent to Pixabay API
//   tags     : string[] — exact/primary tags (score +15 per exact match)
//   related  : string[] — secondary tags (score +5 per match)
//   reject   : string[] — tags that indicate a wrong-category result (score -20 per match)
//   minScore : number   — minimum total before image is accepted (default 15)
// }
const VOCAB = {
  // ── Travel & booking ──
  hotel:       { query: 'hotel building exterior lobby',
                 tags:    ['hotel','lobby','accommodation','reception'],
                 related: ['building','entrance','resort','room'],
                 reject:  ['classroom','school','hospital','food'] },
  motel:       { query: 'motel sign road exterior',
                 tags:    ['motel','sign','road'],
                 related: ['hotel','building','parking'],
                 reject:  ['classroom','school'] },
  hostel:      { query: 'hostel dormitory beds backpacker',
                 tags:    ['hostel','dormitory','backpacker'],
                 related: ['beds','travel','budget'],
                 reject:  ['classroom','school'] },
  ticket:      { query: 'ticket paper stub event entrance',
                 tags:    ['ticket','stub','entrance','event'],
                 related: ['paper','concert','gate','cinema'],
                 reject:  ['classroom','school','food','animal'] },
  reservation: { query: 'hotel reception booking desk',
                 tags:    ['reservation','booking','reception'],
                 related: ['desk','hotel','check','form'],
                 reject:  [] },
  booking:     { query: 'hotel reception booking desk',
                 tags:    ['booking','reservation','reception'],
                 related: ['desk','hotel'],
                 reject:  [] },
  room:        { query: 'hotel room bed interior',
                 tags:    ['room','bed','hotel','bedroom'],
                 related: ['interior','furniture','pillow'],
                 reject:  ['classroom','outdoor'] },
  seat:        { query: 'seat chair airplane train',
                 tags:    ['seat','chair'],
                 related: ['airplane','train','sitting','cushion'],
                 reject:  ['food','animal'] },
  passport:    { query: 'passport travel document cover',
                 tags:    ['passport','document','identity'],
                 related: ['travel','cover','border','visa'],
                 reject:  ['food','animal','classroom'] },
  suitcase:    { query: 'suitcase luggage travel packed',
                 tags:    ['suitcase','luggage'],
                 related: ['travel','packed','handle','airport'],
                 reject:  ['food','animal','classroom'] },
  luggage:     { query: 'luggage suitcase travel airport',
                 tags:    ['luggage','suitcase'],
                 related: ['travel','airport','bag','trip'],
                 reject:  ['food','classroom'] },
  map:         { query: 'paper map travel unfolded road',
                 tags:    ['map','navigation'],
                 related: ['paper','travel','road','geography'],
                 reject:  ['food','animal','classroom'] },
  check_in:    { query: 'airport check-in counter desk',
                 tags:    ['check-in','counter','airport'],
                 related: ['desk','staff','boarding'],
                 reject:  ['food','animal'] },

  // ── Transport ──
  bus:         { query: 'bus public transport street passengers',
                 tags:    ['bus'],
                 related: ['transport','vehicle','street','passengers'],
                 reject:  ['food','animal','classroom'] },
  car:         { query: 'car vehicle road parked',
                 tags:    ['car','automobile'],
                 related: ['road','vehicle','drive','transport'],
                 reject:  ['food','classroom','boat'] },
  train:       { query: 'train railway station platform',
                 tags:    ['train','railway'],
                 related: ['station','platform','transport','tracks'],
                 reject:  ['food','classroom'] },
  plane:       { query: 'airplane aircraft sky flying',
                 tags:    ['airplane','aircraft'],
                 related: ['sky','flying','flight','wing'],
                 reject:  ['food','classroom','boat'] },
  airplane:    { query: 'airplane aircraft sky flying',
                 tags:    ['airplane','aircraft'],
                 related: ['sky','flying','flight','wing'],
                 reject:  ['food','classroom','boat'] },
  flight:      { query: 'airplane flight sky airport departure',
                 tags:    ['airplane','flight'],
                 related: ['aircraft','sky','airport','departure'],
                 reject:  ['food','classroom'] },
  boat:        { query: 'boat sea water sailing',
                 tags:    ['boat','vessel'],
                 related: ['water','sea','sailing','ocean'],
                 reject:  ['food','classroom','car'] },
  ship:        { query: 'ship ocean large vessel cargo',
                 tags:    ['ship','vessel'],
                 related: ['ocean','sea','large','cargo'],
                 reject:  ['food','classroom'] },
  bicycle:     { query: 'bicycle bike riding road',
                 tags:    ['bicycle','bike'],
                 related: ['riding','road','cycle','wheel'],
                 reject:  ['food','classroom','motor'] },
  bike:        { query: 'bicycle bike riding road',
                 tags:    ['bicycle','bike'],
                 related: ['riding','road','cycle'],
                 reject:  ['food','classroom','motor'] },
  taxi:        { query: 'taxi cab street city',
                 tags:    ['taxi','cab'],
                 related: ['street','city','hire','yellow'],
                 reject:  ['food','classroom'] },

  // ── Places / buildings ──
  restaurant:  { query: 'restaurant interior tables dining',
                 tags:    ['restaurant','dining'],
                 related: ['tables','chairs','interior','food','menu'],
                 reject:  ['classroom','hospital','outdoor'] },
  cafe:        { query: 'cafe coffee shop interior counter',
                 tags:    ['cafe','coffee shop'],
                 related: ['coffee','counter','interior','bakery'],
                 reject:  ['classroom','hospital'] },
  school:      { query: 'school building exterior entrance education',
                 tags:    ['school','education'],
                 related: ['building','exterior','entrance','students'],
                 reject:  ['hospital','food','transport'] },
  classroom:   { query: 'classroom desks board school students',
                 tags:    ['classroom','desks','board'],
                 related: ['teacher','school','chairs','students'],
                 reject:  ['food','transport','outdoor'] },
  hospital:    { query: 'hospital building exterior sign medical',
                 tags:    ['hospital','medical'],
                 related: ['building','exterior','sign','emergency'],
                 reject:  ['school','classroom','food','transport'] },
  airport:     { query: 'airport terminal interior departure gate',
                 tags:    ['airport','terminal'],
                 related: ['departure','gate','travel','interior'],
                 reject:  ['school','food','animal'] },
  house:       { query: 'house residential building exterior garden',
                 tags:    ['house','home'],
                 related: ['building','exterior','residential','garden','door'],
                 reject:  ['school','hospital','transport'] },
  home:        { query: 'house home exterior front door',
                 tags:    ['house','home'],
                 related: ['exterior','garden','door','residential'],
                 reject:  ['school','hospital','transport'] },
  shop:        { query: 'shop store retail front window display',
                 tags:    ['shop','store','retail'],
                 related: ['window','front','display','products'],
                 reject:  ['school','hospital'] },
  store:       { query: 'store shop retail shelves interior',
                 tags:    ['store','shop','retail'],
                 related: ['shelves','interior','products'],
                 reject:  ['school','hospital'] },
  market:      { query: 'outdoor market stalls vegetables sellers',
                 tags:    ['market','stalls'],
                 related: ['outdoor','vegetables','fruit','sellers'],
                 reject:  ['school','hospital','transport'] },
  library:     { query: 'library shelves books interior reading',
                 tags:    ['library','books','shelves'],
                 related: ['reading','interior','quiet','knowledge'],
                 reject:  ['food','transport'] },
  kitchen:     { query: 'kitchen room stove counter cooking',
                 tags:    ['kitchen','cooking','stove'],
                 related: ['counter','room','appliances'],
                 reject:  ['transport','classroom'] },
  garden:      { query: 'garden flowers plants green outdoor',
                 tags:    ['garden','flowers','plants'],
                 related: ['green','outdoor','lawn'],
                 reject:  ['indoor','transport','food'] },
  office:      { query: 'office desk workplace computer',
                 tags:    ['office','desk','workplace'],
                 related: ['computer','chair','work','professional'],
                 reject:  ['outdoor','classroom'] },
  park:        { query: 'park green trees path outdoor bench',
                 tags:    ['park','green','trees'],
                 related: ['path','outdoor','bench'],
                 reject:  ['indoor','transport','food'] },
  beach:       { query: 'beach sand sea waves sunny',
                 tags:    ['beach','sand','sea'],
                 related: ['waves','sunny','shore','ocean'],
                 reject:  ['indoor','transport','classroom'] },
  mountain:    { query: 'mountain peak landscape scenic',
                 tags:    ['mountain','peak'],
                 related: ['landscape','scenic','hiking','snow'],
                 reject:  ['indoor','transport','food'] },
  city:        { query: 'city skyline buildings street urban',
                 tags:    ['city','skyline','urban'],
                 related: ['buildings','street','traffic'],
                 reject:  ['indoor','food','animal'] },
  town:        { query: 'town square small buildings street',
                 tags:    ['town','square'],
                 related: ['buildings','street','small','community'],
                 reject:  ['indoor','food','animal'] },

  // ── Food & drink ──
  apple:       { query: 'apple fruit red isolated',
                 tags:    ['apple','fruit'],
                 related: ['red','food','healthy','fresh'],
                 reject:  ['phone','computer','classroom','person','animal'] },
  banana:      { query: 'banana fruit yellow isolated',
                 tags:    ['banana','fruit'],
                 related: ['yellow','food','tropical','fresh'],
                 reject:  ['person','animal','transport','classroom'] },
  orange:      { query: 'orange citrus fruit isolated',
                 tags:    ['orange','citrus','fruit'],
                 related: ['food','healthy','fresh'],
                 reject:  ['person','animal','transport','classroom'] },
  bread:       { query: 'bread loaf bakery baked wheat',
                 tags:    ['bread','loaf','bakery'],
                 related: ['baked','food','wheat'],
                 reject:  ['animal','transport','classroom'] },
  milk:        { query: 'milk glass bottle white drink dairy',
                 tags:    ['milk','dairy'],
                 related: ['glass','bottle','white','drink'],
                 reject:  ['animal','transport','classroom'] },
  water:       { query: 'water glass drink clear transparent',
                 tags:    ['water','drink'],
                 related: ['glass','clear','transparent','fresh'],
                 reject:  ['ocean','sea','animal','classroom'] },
  coffee:      { query: 'coffee cup espresso hot drink',
                 tags:    ['coffee','espresso'],
                 related: ['cup','hot','drink','cafe'],
                 reject:  ['animal','transport','classroom'] },
  tea:         { query: 'tea cup hot drink herbal mug',
                 tags:    ['tea'],
                 related: ['cup','hot','herbal','drink','mug'],
                 reject:  ['animal','transport','classroom'] },
  egg:         { query: 'egg breakfast food protein',
                 tags:    ['egg','breakfast'],
                 related: ['food','protein','yolk','shell'],
                 reject:  ['animal','transport','classroom'] },
  eggs:        { query: 'eggs basket breakfast food farm',
                 tags:    ['eggs','basket','breakfast'],
                 related: ['food','protein','farm'],
                 reject:  ['animal','transport','classroom'] },
  rice:        { query: 'rice bowl cooked white food grain',
                 tags:    ['rice','bowl'],
                 related: ['cooked','white','food','grain'],
                 reject:  ['animal','transport','classroom'] },
  fish:        { query: 'fish swimming underwater sea aquatic',
                 tags:    ['fish','underwater','aquatic'],
                 related: ['animal','swimming','sea','ocean'],
                 reject:  ['food','cooked','meal','plate','fried'] },
  chicken:     { query: 'chicken cooked meal plate food roast',
                 tags:    ['chicken','cooked','meal','plate'],
                 related: ['food','roast'],
                 reject:  ['live','farm','animal','transport'] },
  pizza:       { query: 'pizza whole round italian cheese',
                 tags:    ['pizza','round','italian'],
                 related: ['food','cheese','toppings'],
                 reject:  ['animal','transport','classroom'] },
  salad:       { query: 'salad bowl vegetables fresh healthy',
                 tags:    ['salad','bowl','vegetables'],
                 related: ['healthy','fresh','green','food'],
                 reject:  ['animal','transport','classroom'] },
  cake:        { query: 'cake dessert sweet birthday frosting',
                 tags:    ['cake','dessert','sweet'],
                 related: ['birthday','frosting','baked'],
                 reject:  ['animal','transport','classroom'] },
  soup:        { query: 'soup bowl hot food vegetable',
                 tags:    ['soup','bowl'],
                 related: ['hot','food','vegetable','broth','spoon'],
                 reject:  ['animal','transport','classroom'] },
  sandwich:    { query: 'sandwich bread filling lunch',
                 tags:    ['sandwich','bread'],
                 related: ['filling','lunch','food','deli'],
                 reject:  ['animal','transport','classroom'] },
  burger:      { query: 'burger hamburger bun fast food',
                 tags:    ['burger','hamburger'],
                 related: ['bun','fast food','cheese','beef'],
                 reject:  ['animal','transport','classroom'] },
  pasta:       { query: 'pasta spaghetti italian food plate',
                 tags:    ['pasta','spaghetti'],
                 related: ['italian','food','plate','sauce'],
                 reject:  ['animal','transport','classroom'] },
  chocolate:   { query: 'chocolate bar sweet dark brown',
                 tags:    ['chocolate'],
                 related: ['sweet','dark','brown','bar','food'],
                 reject:  ['animal','transport','classroom'] },
  ice_cream:   { query: 'ice cream scoop cone dessert',
                 tags:    ['ice cream','scoop','cone'],
                 related: ['dessert','sweet','cold'],
                 reject:  ['animal','transport','classroom'] },
  juice:       { query: 'juice glass fresh fruit drink',
                 tags:    ['juice'],
                 related: ['glass','fresh','fruit','drink'],
                 reject:  ['animal','transport','classroom'] },
  cheese:      { query: 'cheese block dairy food yellow',
                 tags:    ['cheese','dairy'],
                 related: ['food','yellow','block','slice'],
                 reject:  ['animal','transport','classroom'] },
  butter:      { query: 'butter dish dairy food spread',
                 tags:    ['butter','dairy'],
                 related: ['food','spread','dish'],
                 reject:  ['animal','transport','classroom'] },
  honey:       { query: 'honey jar golden sweet food',
                 tags:    ['honey','jar'],
                 related: ['golden','sweet','food'],
                 reject:  ['animal','transport','classroom'] },
  cookie:      { query: 'cookie biscuit baked sweet food',
                 tags:    ['cookie','biscuit'],
                 related: ['baked','sweet','food'],
                 reject:  ['animal','transport','classroom'] },
  potato:      { query: 'potato vegetable food raw',
                 tags:    ['potato','vegetable'],
                 related: ['food','raw','starch'],
                 reject:  ['animal','transport','classroom'] },
  tomato:      { query: 'tomato red vegetable fresh',
                 tags:    ['tomato','vegetable'],
                 related: ['red','fresh','food','salad'],
                 reject:  ['animal','transport','classroom'] },
  carrot:      { query: 'carrot orange vegetable fresh',
                 tags:    ['carrot','vegetable'],
                 related: ['orange','fresh','food'],
                 reject:  ['animal','transport','classroom'] },
  table:       { query: 'dining table wooden furniture room',
                 tags:    ['table','dining','furniture'],
                 related: ['wooden','room','surface'],
                 reject:  ['outdoor','transport','food'] },
  chair:       { query: 'chair furniture wooden seat',
                 tags:    ['chair','furniture'],
                 related: ['wooden','seat','sitting','legs'],
                 reject:  ['outdoor','transport','food'] },

  // ── Animals ──
  cat:         { query: 'cat kitten pet domestic',
                 tags:    ['cat','kitten'],
                 related: ['pet','domestic','cute','fur'],
                 reject:  ['food','transport','classroom'] },
  dog:         { query: 'dog puppy pet domestic',
                 tags:    ['dog','puppy'],
                 related: ['pet','domestic','cute','breed'],
                 reject:  ['food','transport','classroom'] },
  bird:        { query: 'bird colorful perched feathers',
                 tags:    ['bird','feathers'],
                 related: ['colorful','perched','branch','wings'],
                 reject:  ['food','transport','classroom'] },
  horse:       { query: 'horse animal field running',
                 tags:    ['horse'],
                 related: ['animal','field','running','mane','farm'],
                 reject:  ['food','transport','classroom'] },
  cow:         { query: 'cow farm animal field grass dairy',
                 tags:    ['cow','dairy'],
                 related: ['farm','animal','field','grass'],
                 reject:  ['food','transport','classroom'] },
  sheep:       { query: 'sheep farm animal wool field',
                 tags:    ['sheep','wool'],
                 related: ['farm','animal','field','grass'],
                 reject:  ['food','transport','classroom'] },
  rabbit:      { query: 'rabbit bunny pet ears fur',
                 tags:    ['rabbit','bunny'],
                 related: ['pet','ears','fur','cute'],
                 reject:  ['food','transport','classroom'] },
  elephant:    { query: 'elephant wildlife africa trunk',
                 tags:    ['elephant','trunk'],
                 related: ['wildlife','africa','large','grey'],
                 reject:  ['food','transport','classroom'] },
  lion:        { query: 'lion wildlife africa mane',
                 tags:    ['lion','mane'],
                 related: ['wildlife','africa','predator'],
                 reject:  ['food','transport','classroom'] },
  goldfish:    { query: 'goldfish aquarium orange water tank',
                 tags:    ['goldfish','aquarium'],
                 related: ['orange','water','tank','pet'],
                 reject:  ['food','transport','classroom'] },

  // ── School objects ──
  pencil:      { query: 'pencil yellow stationery isolated write',
                 tags:    ['pencil','stationery'],
                 related: ['yellow','write','school','eraser'],
                 reject:  ['food','transport','animal'] },
  pen:         { query: 'pen ballpoint stationery writing ink',
                 tags:    ['pen','ballpoint','stationery'],
                 related: ['writing','school','ink'],
                 reject:  ['food','transport','animal'] },
  book:        { query: 'book open pages reading text',
                 tags:    ['book','pages','reading'],
                 related: ['open','text','story','school'],
                 reject:  ['food','transport','animal'] },
  books:       { query: 'books stack library knowledge',
                 tags:    ['books','library'],
                 related: ['stack','reading','knowledge','shelves'],
                 reject:  ['food','transport','animal'] },
  notebook:    { query: 'notebook spiral paper school notes',
                 tags:    ['notebook','spiral'],
                 related: ['paper','school','writing','notes'],
                 reject:  ['food','transport','animal'] },
  bag:         { query: 'shopping bag handles carry retail',
                 tags:    ['bag','shopping'],
                 related: ['handles','carry','retail','plastic','paper','store'],
                 reject:  ['backpack','school','suitcase','luggage','classroom'] },
  backpack:    { query: 'backpack school student colorful zipper',
                 tags:    ['backpack','school','student'],
                 related: ['colorful','bag','zipper'],
                 reject:  ['food','transport','animal','suitcase'] },
  schoolbag:   { query: 'school bag backpack student carry',
                 tags:    ['school','bag','backpack','student'],
                 related: ['carry','zipper'],
                 reject:  ['food','transport','animal','suitcase'] },
  computer:    { query: 'laptop computer desk keyboard screen',
                 tags:    ['laptop','computer'],
                 related: ['desk','screen','keyboard','modern','work'],
                 reject:  ['food','transport','animal','outdoor'] },
  laptop:      { query: 'laptop computer open screen keyboard',
                 tags:    ['laptop','computer'],
                 related: ['open','screen','keyboard','work'],
                 reject:  ['food','transport','animal','outdoor'] },
  phone:       { query: 'smartphone mobile phone touchscreen',
                 tags:    ['smartphone','mobile','phone'],
                 related: ['screen','modern','app'],
                 reject:  ['food','transport','animal','landline'] },
  mobile:      { query: 'mobile smartphone touchscreen screen',
                 tags:    ['mobile','smartphone'],
                 related: ['touchscreen','phone','screen','app'],
                 reject:  ['food','transport','animal'] },
  clock:       { query: 'clock wall round time hands',
                 tags:    ['clock','time'],
                 related: ['wall','round','hands','hour'],
                 reject:  ['food','transport','animal'] },
  watch:       { query: 'wristwatch arm time elegant strap',
                 tags:    ['watch','wristwatch'],
                 related: ['arm','time','elegant','strap'],
                 reject:  ['food','transport','animal','wall'] },
  door:        { query: 'door wooden entrance closed handle',
                 tags:    ['door','entrance'],
                 related: ['wooden','closed','handle','frame'],
                 reject:  ['food','transport','animal'] },
  window:      { query: 'window glass light view frame',
                 tags:    ['window','glass'],
                 related: ['light','view','frame','clear'],
                 reject:  ['food','transport','animal'] },

  // ── People / roles ──
  teacher:     { query: 'teacher classroom whiteboard education',
                 tags:    ['teacher','classroom','whiteboard'],
                 related: ['students','education','teaching'],
                 reject:  ['food','transport','animal'] },
  doctor:      { query: 'doctor medical white coat stethoscope',
                 tags:    ['doctor','stethoscope'],
                 related: ['medical','coat','health','hospital'],
                 reject:  ['food','transport','animal','classroom'] },
  student:     { query: 'student studying desk reading book',
                 tags:    ['student','studying'],
                 related: ['desk','reading','book','school'],
                 reject:  ['food','transport','animal'] },
  family:      { query: 'family parents children happy together',
                 tags:    ['family','parents','children'],
                 related: ['happy','together','love'],
                 reject:  ['food','transport','animal','classroom'] },
  children:    { query: 'children playing happy outdoor kids',
                 tags:    ['children','kids'],
                 related: ['playing','happy','outdoor'],
                 reject:  ['food','transport','animal'] },
  child:       { query: 'child playing happy smiling kid',
                 tags:    ['child','kid'],
                 related: ['playing','happy','smiling','young'],
                 reject:  ['food','transport','animal'] },
  baby:        { query: 'baby infant sleeping cute newborn',
                 tags:    ['baby','infant','newborn'],
                 related: ['sleeping','cute','small'],
                 reject:  ['food','transport','animal'] },
  man:         { query: 'man adult portrait smiling',
                 tags:    ['man','adult'],
                 related: ['portrait','smiling','male','person'],
                 reject:  ['food','transport','animal'] },
  woman:       { query: 'woman adult portrait smiling',
                 tags:    ['woman','adult'],
                 related: ['portrait','smiling','female','person'],
                 reject:  ['food','transport','animal'] },
  friend:      { query: 'friends smiling together happy group',
                 tags:    ['friends','smiling'],
                 related: ['together','happy','group','young'],
                 reject:  ['food','transport','animal'] },
  friends:     { query: 'friends smiling together happy group',
                 tags:    ['friends','smiling'],
                 related: ['together','happy','group','young'],
                 reject:  ['food','transport','animal'] },
};

// ─── Default minimum relevance score ──────────────────────────────────────
const DEFAULT_MIN_SCORE = 15;

// ─── Relevance scorer ─────────────────────────────────────────────────────
// Scoring:
//   +15  exact primary tag match  (full equality)
//   +8   partial primary tag overlap (one contains the other)
//   +5   related tag match (exact)
//   +2   related tag partial match
//   -20  reject tag found in hit
//   +5   photo type bonus
//   +3   landscape orientation bonus
//   +4   width >= 1280
//   +2   width >= 640
//   -3   > 8 tags (noisy/unrelated result)
function scoreHit(hit, vocab) {
  const rawHitTags = (hit.tags || '').toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
  const hitType    = (hit.type || '').toLowerCase();
  let score = 0;

  // Reject tags first — bail early if heavily penalised
  for (const reject of (vocab.reject || [])) {
    if (rawHitTags.some(ht => ht === reject || ht.includes(reject))) {
      score -= 20;
    }
  }

  // Primary tags — exact beats partial
  for (const tag of (vocab.tags || [])) {
    if (rawHitTags.includes(tag)) {
      score += 15;                      // exact match
    } else if (rawHitTags.some(ht => ht.includes(tag) || tag.includes(ht))) {
      score += 8;                       // partial overlap
    }
  }

  // Secondary/related tags
  for (const tag of (vocab.related || [])) {
    if (rawHitTags.includes(tag)) {
      score += 5;
    } else if (rawHitTags.some(ht => ht.includes(tag) || tag.includes(ht))) {
      score += 2;
    }
  }

  // Media quality bonuses
  if (hitType === 'photo')                  score += 5;
  if (hit.imageWidth > hit.imageHeight)     score += 3;   // landscape
  if (hit.imageWidth >= 1280)               score += 4;
  else if (hit.imageWidth >= 640)           score += 2;
  if (rawHitTags.length > 8)               score -= 3;   // noisy hit

  return score;
}

// ─── Unique, safe storage path ────────────────────────────────────────────
// Include Pixabay image ID so re-fetches of the same word get a fresh file
// rather than silently reusing a stale or corrupt one.
function storagePath(word, pixabayId, ext) {
  // Sanitise word: only a-z, 0-9, underscore (already validated upstream)
  const safeWord = word.replace(/[^a-z0-9_]/g, '_').slice(0, 40);
  return `vocab/${safeWord}_${pixabayId}.${ext}`;
}

// ─── MIME → extension ─────────────────────────────────────────────────────
function mimeToExt(mime) {
  if (mime.includes('png'))  return 'png';
  if (mime.includes('webp')) return 'webp';
  return 'jpg';
}

// ─── Supabase helpers (raw fetch — no SDK) ────────────────────────────────
function sbHeaders(key) {
  return {
    'apikey':        key,
    'Authorization': `Bearer ${key}`,
    'Content-Type':  'application/json',
  };
}

// Returns cached row or null. Cache failures are non-fatal (returns null).
async function cacheGet(supabaseUrl, serviceKey, cacheKey) {
  try {
    const url = `${supabaseUrl}/rest/v1/ws_image_cache?word=eq.${encodeURIComponent(cacheKey)}&select=*&limit=1`;
    const r   = await fetch(url, { headers: sbHeaders(serviceKey) });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    const age = Date.now() - new Date(row.cached_at).getTime();
    if (age > 24 * 60 * 60 * 1000) return null;   // TTL expired
    return row;
  } catch (_) { return null; }
}

// Writes cache row. Failures are non-fatal — worksheet still shows image.
async function cacheSet(supabaseUrl, serviceKey, cacheKey, data) {
  try {
    const body = JSON.stringify({
      word:             cacheKey,
      cdn_url:          data.cdn_url,
      attribution_name: data.attribution_name,
      attribution_url:  data.attribution_url,
      pixabay_page:     data.pixabay_page,
      cached_at:        new Date().toISOString(),
    });
    const r = await fetch(`${supabaseUrl}/rest/v1/ws_image_cache`, {
      method:  'POST',
      headers: { ...sbHeaders(serviceKey), 'Prefer': 'resolution=merge-duplicates' },
      body,
    });
    return r.ok;
  } catch (_) { return false; }
}

// Uploads binary to Supabase Storage. Throws on failure.
async function uploadToStorage(supabaseUrl, serviceKey, path, imageBuffer, contentType) {
  const uploadUrl = `${supabaseUrl}/storage/v1/object/worksheet-images/${path}`;
  const r = await fetch(uploadUrl, {
    method:  'POST',
    headers: {
      'apikey':         serviceKey,
      'Authorization':  `Bearer ${serviceKey}`,
      'Content-Type':   contentType,
      'x-upsert':       'true',
    },
    body: imageBuffer,
  });
  if (!r.ok) {
    const err = await r.text().catch(() => r.status.toString());
    throw new Error(`Storage upload failed: ${r.status} ${err.slice(0, 120)}`);
  }
  return `${supabaseUrl}/storage/v1/object/public/worksheet-images/${path}`;
}

// ─── Download with timeout ────────────────────────────────────────────────
async function downloadWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    return r;
  } finally {
    clearTimeout(timer);
  }
}

// ─── In-process dedup lock ────────────────────────────────────────────────
// Prevents two concurrent requests for the same word from both hitting
// Pixabay and uploading simultaneously. Key = cache key; value = Promise.
const inflight = new Map();

// ─── Main handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {

  // ── CORS — restrict to known NIRA origins ──
  const origin = req.headers.origin || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : (ALLOWED_ORIGINS[0]);   // fallback for direct/server calls
  res.setHeader('Access-Control-Allow-Origin',  corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  // ── Input validation ──
  const raw = (req.query.q || '').trim().toLowerCase();
  if (!raw || raw.length > 50 || !/^[a-z0-9 _-]+$/.test(raw)) {
    res.status(400).json({ error: 'Invalid query' }); return;
  }
  const word = raw.replace(/\s+/g, '_');

  // ── Env var validation ──
  const pixabayKey  = process.env.PIXABAY_API_KEY;
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
  if (!pixabayKey)               { res.status(500).json({ error: 'Image service not configured' }); return; }
  if (!supabaseUrl || !serviceKey) { res.status(500).json({ error: 'Storage not configured' });        return; }

  // ── Vocabulary check — no bare-word fallback ──
  const vocab = VOCAB[word] || VOCAB[raw.replace(/\s+/g, '_')];
  if (!vocab) { res.status(200).json({ error: 'not found' }); return; }

  const minScore = typeof vocab.minScore === 'number' ? vocab.minScore : DEFAULT_MIN_SCORE;
  const cacheKey = word;   // one entry per canonical word

  // ── Cache hit ──
  try {
    const cached = await cacheGet(supabaseUrl, serviceKey, cacheKey);
    if (cached) {
      res.status(200).json({
        url:         cached.cdn_url,
        attribution: {
          name:    cached.attribution_name,
          profile: cached.attribution_url,
          page:    cached.pixabay_page,
        },
        cached: true,
      });
      return;
    }
  } catch (_) { /* cache unavailable — proceed to fresh fetch */ }

  // ── Dedup: if same word already in-flight, wait for it ──
  if (inflight.has(cacheKey)) {
    try {
      const result = await inflight.get(cacheKey);
      res.status(200).json({ ...result, cached: true }); return;
    } catch (_) {
      res.status(200).json({ error: 'not found' }); return;
    }
  }

  // ── Kick off fetch + upload, register in-flight promise ──
  let resolveInflight, rejectInflight;
  const inflightPromise = new Promise((res, rej) => { resolveInflight = res; rejectInflight = rej; });
  inflight.set(cacheKey, inflightPromise);

  try {
    // ── Pixabay search ──
    const params = new URLSearchParams({
      key:          pixabayKey,
      q:            vocab.query,
      image_type:   'photo',
      orientation:  'horizontal',
      safesearch:   'true',
      per_page:     '15',    // fetch more candidates for better scoring
      min_width:    '640',
    });
    const searchRes = await fetch(`https://pixabay.com/api/?${params}`);
    if (!searchRes.ok) {
      res.status(502).json({ error: 'Upstream search error' }); rejectInflight(new Error('search')); return;
    }
    const searchData = await searchRes.json();
    if (!searchData.hits || searchData.hits.length === 0) {
      res.status(200).json({ error: 'not found' }); rejectInflight(new Error('no hits')); return;
    }

    // ── Score all hits; pick best ──
    const scored = searchData.hits
      .map(hit => ({ hit, score: scoreHit(hit, vocab) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best.score < minScore) {
      console.warn(`[images] ${word}: best score ${best.score} < min ${minScore}; top tags: ${best.hit.tags}`);
      res.status(200).json({ error: 'not found' }); rejectInflight(new Error('low score')); return;
    }
    const hit = best.hit;

    // ── Download image with timeout ──
    let imgRes;
    try {
      imgRes = await downloadWithTimeout(hit.webformatURL, DOWNLOAD_TIMEOUT);
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'Image download timed out' : 'Image download failed';
      res.status(502).json({ error: msg }); rejectInflight(e); return;
    }
    if (!imgRes.ok) {
      res.status(502).json({ error: 'Image download failed' }); rejectInflight(new Error('dl')); return;
    }

    // ── Validate content-type ──
    const rawCT      = (imgRes.headers.get('content-type') || 'image/jpeg').toLowerCase().split(';')[0].trim();
    const contentType = ALLOWED_MIME.has(rawCT) ? rawCT : 'image/jpeg';

    // ── Read and size-check body ──
    const imageBuffer = await imgRes.arrayBuffer();
    if (imageBuffer.byteLength < MIN_IMAGE_BYTES) {
      res.status(502).json({ error: 'Image too small' }); rejectInflight(new Error('tiny')); return;
    }
    if (imageBuffer.byteLength > MAX_IMAGE_BYTES) {
      res.status(502).json({ error: 'Image too large' }); rejectInflight(new Error('huge')); return;
    }

    // ── Upload to Supabase Storage (unique path per Pixabay image ID) ──
    const ext  = mimeToExt(contentType);
    const path = storagePath(word, hit.id, ext);
    const cdnUrl = await uploadToStorage(supabaseUrl, serviceKey, path, imageBuffer, contentType);

    // ── Build attribution ──
    const attribution = {
      name:    hit.user,
      profile: `https://pixabay.com/users/${hit.user}-${hit.user_id}/`,
      page:    hit.pageURL,
    };

    // ── Write cache (non-fatal) ──
    await cacheSet(supabaseUrl, serviceKey, cacheKey, {
      cdn_url:          cdnUrl,
      attribution_name: attribution.name,
      attribution_url:  attribution.profile,
      pixabay_page:     attribution.page,
    });

    const payload = { url: cdnUrl, attribution, cached: false };
    resolveInflight(payload);
    res.status(200).json(payload);

  } catch (e) {
    console.error('[images.js]', e.message);
    rejectInflight(e);
    res.status(502).json({ error: 'Service error' });
  } finally {
    // Clean up in-flight entry after short delay (allow racing requests to use it)
    setTimeout(() => inflight.delete(cacheKey), 5000);
  }
}
