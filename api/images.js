
// /api/images.js
// NIR Academy — Smart Vocabulary Image Search
// GET /api/images?q=apple
// Compatible response: { url, pageURL }

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to',
  'for', 'and', 'or', 'with', 'from', 'by'
]);

const CATEGORY_TERMS = {
  food: [
    'food', 'fruit', 'vegetable', 'drink', 'meal',
    'bread', 'rice', 'meat', 'fish', 'chicken',
    'apple', 'banana', 'orange', 'pizza', 'cake',
    'coffee', 'tea', 'milk', 'water', 'soup',
    'sandwich', 'cheese', 'egg', 'potato', 'tomato'
  ],
  animal: [
    'animal', 'pet', 'wildlife', 'bird', 'fish',
    'cat', 'dog', 'horse', 'cow', 'lion', 'tiger',
    'elephant', 'monkey', 'rabbit', 'snake',
    'butterfly', 'dolphin', 'whale', 'penguin'
  ],
  place: [
    'hotel', 'school', 'hospital', 'restaurant',
    'airport', 'station', 'library', 'museum',
    'office', 'bank', 'shop', 'market', 'park',
    'beach', 'mountain', 'village', 'city',
    'kitchen', 'bedroom', 'bathroom', 'classroom'
  ],
  transport: [
    'car', 'bus', 'train', 'plane', 'airplane',
    'bicycle', 'bike', 'taxi', 'truck', 'boat',
    'ship', 'motorcycle', 'helicopter', 'subway'
  ],
  clothing: [
    'shirt', 'trousers', 'jeans', 'dress', 'skirt',
    'jacket', 'coat', 'shoes', 'boots', 'hat',
    'cap', 'socks', 'scarf', 'gloves', 'sweater'
  ],
  people: [
    'teacher', 'student', 'doctor', 'nurse',
    'police', 'policeman', 'firefighter', 'chef',
    'farmer', 'driver', 'pilot', 'waiter',
    'woman', 'man', 'child', 'baby', 'family'
  ],
  objects: [
    'book', 'pen', 'pencil', 'table', 'chair',
    'computer', 'laptop', 'phone', 'camera',
    'clock', 'door', 'window', 'bag', 'watch',
    'lamp', 'bed', 'sofa', 'mirror', 'bottle'
  ],
  nature: [
    'tree', 'flower', 'forest', 'river', 'lake',
    'ocean', 'sea', 'desert', 'sun', 'moon',
    'star', 'cloud', 'rain', 'snow', 'rainbow',
    'mountain', 'waterfall', 'grass', 'leaf'
  ],
  sport: [
    'football', 'soccer', 'basketball', 'tennis',
    'volleyball', 'swimming', 'running', 'cycling',
    'skiing', 'boxing', 'golf', 'yoga', 'gym'
  ],
  technology: [
    'robot', 'internet', 'software', 'keyboard',
    'printer', 'tablet', 'smartphone', 'drone',
    'headphones', 'microphone', 'screen'
  ]
};

const ACTION_TERMS = [
  'running', 'walking', 'swimming', 'cooking',
  'reading', 'writing', 'playing', 'dancing',
  'singing', 'driving', 'sleeping', 'eating',
  'drinking', 'working', 'studying', 'shopping',
  'traveling', 'travelling', 'cleaning', 'painting',
  'teaching', 'learning', 'cycling', 'climbing',
  'fishing', 'flying', 'laughing', 'crying'
];

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ');
}

function wordsOf(value) {
  return normalize(value)
    .split(' ')
    .filter(word => word && !STOP_WORDS.has(word));
}

function detectCategory(query) {
  const words = wordsOf(query);

  for (const [category, terms] of Object.entries(CATEGORY_TERMS)) {
    if (words.some(word => terms.includes(word))) {
      return category;
    }
  }

  if (words.some(word => ACTION_TERMS.includes(word))) {
    return 'action';
  }

  if (words.some(word =>
    /^(tion|sion|ness|ment|ity|ism|ance|ence)$/.test(word.slice(-4))
  )) {
    return 'concept';
  }

  return 'general';
}

function expandQueries(input) {
  const q = normalize(input);
  const category = detectCategory(q);

  const queries = [];

  // Preserve the complete phrase.
  queries.push(q);

  // Add category-aware alternatives.
  const templates = {
    food: [
      `${q} food`,
      `${q} fresh food`,
      `${q} food photography`
    ],
    animal: [
      `${q} animal`,
      `${q} wildlife`,
      `${q} animal photography`
    ],
    place: [
      `${q} building`,
      `${q} interior exterior`,
      `${q} place photography`
    ],
    transport: [
      `${q} vehicle`,
      `${q} transportation`,
      `${q} vehicle photography`
    ],
    clothing: [
      `${q} clothing`,
      `${q} fashion`,
      `${q} clothing photography`
    ],
    people: [
      `${q} person`,
      `${q} people`,
      `${q} professional photography`
    ],
    objects: [
      `${q} object`,
      `${q} everyday object`,
      `${q} isolated object`
    ],
    nature: [
      `${q} nature`,
      `${q} landscape`,
      `${q} nature photography`
    ],
    sport: [
      `${q} sport`,
      `${q} sports activity`,
      `${q} sports photography`
    ],
    technology: [
      `${q} technology`,
      `${q} modern technology`,
      `${q} technology photography`
    ],
    action: [
      `${q} activity`,
      `person ${q}`,
      `${q} people photography`
    ],
    concept: [
      `${q} concept`,
      `${q} illustration`,
      `${q} real life example`
    ],
    general: [
      `${q} object`,
      `${q} real life`,
      `${q} photography`
    ]
  };

  queries.push(...(templates[category] || templates.general));

  // For phrases, try meaningful individual terms too.
  const words = wordsOf(q);

  if (words.length > 1) {
    for (const word of words.slice(0, 2)) {
      queries.push(word);
    }
  }

  return [...new Set(queries)].slice(0, 5);
}

function scoreImage(hit, query) {
  const tags = normalize(hit.tags || '')
    .split(',')
    .map(tag => normalize(tag));

  const queryWords = wordsOf(query);

  let score = 0;

  for (const word of queryWords) {
    if (tags.some(tag => tag === word)) score += 12;
    else if (tags.some(tag => tag.includes(word))) score += 6;
  }

  if (tags.some(tag => tag === normalize(query))) {
    score += 15;
  }

  if (hit.imageWidth >= 1000) score += 3;
  if (hit.imageHeight >= 600) score += 2;
  if (hit.type === 'photo') score += 2;

  return score;
}

async function pixabaySearch(query, key) {
  const params = new URLSearchParams({
    key,
    q: query,
    image_type: 'photo',
    safesearch: 'true',
    per_page: '10',
    min_width: '400',
    order: 'popular'
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);

  try {
    const response = await fetch(
      `https://pixabay.com/api/?${params}`,
      { signal: controller.signal }
    );

    if (!response.ok) return [];

    const data = await response.json();
    return Array.isArray(data.hits) ? data.hits : [];
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const q = normalize(req.query.q);

  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter: q' });
  }

  if (q.length > 80) {
    return res.status(400).json({ error: 'Query too long' });
  }

  const key = process.env.PIXABAY_API_KEY;

  if (!key) {
    return res.status(500).json({
      error: 'Image service not configured'
    });
  }

  try {
    const queries = expandQueries(q);
    const allHits = new Map();

    for (const searchQuery of queries) {
      const hits = await pixabaySearch(searchQuery, key);

      for (const hit of hits) {
        if (hit.id && !allHits.has(hit.id)) {
          allHits.set(hit.id, hit);
        }
      }

      // Stop early if we already have enough candidates.
      if (allHits.size >= 20) break;
    }

    if (!allHits.size) {
      return res.status(200).json({ error: 'not found' });
    }

    const ranked = [...allHits.values()]
      .map(hit => ({
        hit,
        score: scoreImage(hit, q)
      }))
      .sort((a, b) => b.score - a.score);

    const best = ranked[0].hit;

    if (!best.webformatURL || !best.pageURL) {
      return res.status(200).json({ error: 'not found' });
    }

    return res.status(200).json({
      url: best.webformatURL,
      pageURL: best.pageURL
    });

  } catch (error) {
    console.error('[NIR Image Search]', error.message);

    return res.status(502).json({
      error: 'Image search temporarily unavailable'
    });
  }
}
