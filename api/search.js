// Update STANDARD_MARKS each May rotation (3 most recent regulation letters)
const STANDARD_MARKS = ['H', 'I', 'J'];

// TCG slang → descriptive query expansion for vector search
const TCG_SLANG = {
  'gust': 'switch opponent active pokemon with benched pokemon boss orders',
  'gust effect': 'switch opponent active pokemon with benched pokemon boss orders',
  'pivot': 'switch your active pokemon with benched pokemon free retreat cost zero',
  'wall': 'reduce damage taken prevent damage defender ability',
  'snipe': 'damage benched pokemon directly',
  'mill': 'discard cards from opponent deck',
  'draw supporter': 'draw cards from deck supporter',
  'nuke': 'high damage attack knock out',
  'accelerate': 'attach energy from discard pile hand',
  'reborn': 'revive pokemon from discard pile',
};

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const VECTOR_URL = process.env.UPSTASH_VECTOR_REST_URL;
const VECTOR_TOKEN = process.env.UPSTASH_VECTOR_REST_TOKEN;
const CACHE_TTL = 60 * 60 * 24 * 30; // 30 days

async function cacheGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const d = await r.json();
    if (!d.result) return null;
    const parsed = JSON.parse(d.result);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

async function cacheSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', CACHE_TTL]])
    });
  } catch { /* non-fatal */ }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query, format = 'standard' } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Missing query' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const typeFilter = req.body.type || '';
  const cacheKey = `v3:search:standard:${typeFilter.toLowerCase()}:${query.trim().toLowerCase()}`;

  try {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      const filtered = await filterFlagged(query, cached);
      const pinned = await getPinned(query);
      const filteredPinned = await filterFlagged(query, pinned.map(c => ({ ...c, id: c.id })));
      const existingIds = new Set(filtered.map(m => m.id));
      for (const c of filteredPinned) {
        if (!existingIds.has(c.id)) filtered.push({ id: c.id, name: c.name, relevance: 'high', card: normalizeCard(c) });
      }
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json({ matches: filtered });
    }

    // Expand TCG slang before querying vector index
    const lq = query.trim().toLowerCase();
    const expandedQuery = TCG_SLANG[lq] ? `${query} ${TCG_SLANG[lq]}` : query;

    // Fetch candidate cards from vector index
    const cards = await vectorSearch(expandedQuery, typeFilter);

    if (!cards.length) {
      return res.status(200).json({ matches: [] });
    }

    // Dedupe: Pokémon by name+set (same name in different sets = different card),
    // Trainers/Energy by name only (reprints are functionally identical)
    const seen = new Set();
    const deduped = cards.filter(c => {
      const isPokemon = !['trainer','energy'].includes(c.supertype?.toLowerCase());
      const key = isPokemon ? `${c.name}|${c.setName}` : c.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Filter out cards with enough negative feedback for this query
    const filtered = await filterFlagged(query, deduped);

    const enriched = filtered.map(c => ({
      id: c.id,
      name: c.name,
      relevance: 'high',
      card: normalizeCard(c)
    }));

    // Append any user-pinned cards for this query, subject to the same feedback filter
    const pinned = await getPinned(query);
    const filteredPinned = await filterFlagged(query, pinned);
    const existingIds = new Set(enriched.map(m => m.id));
    for (const c of filteredPinned) {
      if (!existingIds.has(c.id)) {
        enriched.push({ id: c.id, name: c.name, relevance: 'high', card: normalizeCard(c) });
      }
    }

    cacheSet(cacheKey, enriched);

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json({ matches: enriched });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}

function normalizeCard(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    supertype: c.supertype,
    subtypes: c.subtypes || [],
    types: c.types || [],
    abilities: c.abilities || [],
    attacks: c.attacks || [],
    rules: c.rules || [],
    hp: c.hp || '',
    number: c.number || '',
    weaknesses: c.weaknesses || [],
    retreatCost: c.retreatCost || [],
    legalities: c.legalities || {},
    set: { name: c.setName || c.set?.name || '' },
    images: {
      small: c.imageSmall || c.images?.small || '',
      large: c.imageLarge || c.images?.large || ''
    }
  };
}

const NEGATIVE_THRESHOLD = 1;

async function getPinned(query) {
  if (!KV_URL || !KV_TOKEN) return [];
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(`pinned:${query.trim().toLowerCase()}`)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : [];
  } catch { return []; }
}

async function filterFlagged(query, cards) {
  if (!KV_URL || !KV_TOKEN || !cards.length) return cards;
  try {
    const keys = cards.map(c => `feedback:${query.trim().toLowerCase()}:${c.id}:negative`);
    const pipeline = keys.map(k => ['GET', k]);
    const r = await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline)
    });
    const results = await r.json();
    return cards.filter((_, i) => {
      const count = parseInt(results[i]?.result || '0', 10);
      return count < NEGATIVE_THRESHOLD;
    });
  } catch { return cards; }
}

async function vectorSearch(query, typeFilter) {
  if (!VECTOR_URL || !VECTOR_TOKEN) {
    // Fallback to keyword search if vector index not configured
    return keywordSearch(query, typeFilter);
  }

  const r = await fetch(`${VECTOR_URL}/query-data`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VECTOR_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      data: query,
      topK: 100,
      includeMetadata: true
    })
  });

  if (!r.ok) {
    console.error('Vector search failed, falling back to keyword search');
    return keywordSearch(query, typeFilter);
  }

  const data = await r.json();
  let results = (data.result || []).map(r => r.metadata).filter(Boolean);

  // Filter by type if specified
  if (typeFilter) {
    results = results.filter(c => (c.types || []).includes(typeFilter));
  }

  // Safety: ensure all returned cards are standard legal
  results = results.filter(c => STANDARD_MARKS.includes(c.regulationMark));

  return results;
}

// Fallback keyword search (used if vector index not yet set up)
async function keywordSearch(query, typeFilter) {
  const lq = query.toLowerCase();
  let supertypes = ['pokemon', 'trainer'];
  if (/\benergy card\b/.test(lq)) supertypes = ['energy'];
  else if (/\b(trainer|supporter|item|stadium|tool)\b/.test(lq)) supertypes = ['trainer'];

  const keywords = extractKeywords(lq);
  const cardMap = new Map();

  await Promise.all(supertypes.flatMap(supertype => {
    const queries = buildQueries(supertype, keywords, typeFilter);
    return queries.map(async (q) => {
      try {
        const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=30`;
        const r = await fetch(url);
        if (!r.ok) return;
        const data = await r.json();
        (data.data || []).forEach(c => cardMap.set(c.id, {
          id: c.id, name: c.name, supertype: c.supertype, subtypes: c.subtypes || [],
          types: c.types || [], abilities: c.abilities || [], attacks: c.attacks || [],
          rules: c.rules || [], setName: c.set?.name || '', regulationMark: c.regulationMark || '',
          imageSmall: c.images?.small || '', imageLarge: c.images?.large || '',
          number: c.number || '', hp: c.hp || '', weaknesses: c.weaknesses || [],
          retreatCost: c.retreatCost || [], legalities: c.legalities || {}
        }));
      } catch(e) { /* skip */ }
    });
  }));

  let results = Array.from(cardMap.values()).filter(c => STANDARD_MARKS.includes(c.regulationMark));
  return results.slice(0, 60);
}

function extractKeywords(query) {
  const conceptMap = [
    { concepts: ['accelerat', 'attach.*energy', 'energy.*attach'], keywords: ['attach', 'energy'] },
    { concepts: ['fire energy', 'fire.*accelerat'], keywords: ['Fire Energy', 'attach'] },
    { concepts: ['water energy', 'water.*accelerat'], keywords: ['Water Energy', 'attach'] },
    { concepts: ['heal', 'remove.*damage', 'damage.*counter.*remove'], keywords: ['heal', 'remove'] },
    { concepts: ['draw.*card', 'card.*draw'], keywords: ['draw', 'deck'] },
    { concepts: ['search.*deck', 'deck.*search', 'look.*deck'], keywords: ['search', 'deck'] },
    { concepts: ['bench.*protect', 'protect.*bench'], keywords: ['Bench', 'prevent'] },
    { concepts: ['spread.*damage', 'damage.*bench', 'bench.*damage'], keywords: ['Bench', 'damage'] },
    { concepts: ['discard.*hand', 'hand.*discard', 'opponent.*hand'], keywords: ['discard', 'hand'] },
    { concepts: ['move.*energy', 'energy.*move', 'transfer.*energy'], keywords: ['move', 'Energy'] },
    { concepts: ['damage counter', 'damage.*counter'], keywords: ['damage counter'] },
    { concepts: ['special condition', 'poison', 'burn', 'paralyze', 'sleep', 'confuse'], keywords: ['Poisoned', 'Burned'] },
    { concepts: ['extra turn', 'take.*turn'], keywords: ['extra turn'] },
    { concepts: ['prize', 'prize card'], keywords: ['Prize'] },
    { concepts: ['lost zone'], keywords: ['Lost Zone'] },
    { concepts: ['discard pile', 'from discard'], keywords: ['discard pile'] },
    { concepts: ['switch', 'gust', 'boss'], keywords: ['switch', 'Bench'] },
    { concepts: ['evolve', 'evolution'], keywords: ['evolve', 'Evolution'] },
  ];

  const matched = [];
  for (const { concepts, keywords } of conceptMap) {
    if (concepts.some(c => new RegExp(c).test(query))) matched.push(...keywords);
  }

  const types = ['Fire','Water','Grass','Lightning','Psychic','Fighting','Darkness','Metal','Dragon','Fairy','Colorless'];
  for (const t of types) {
    if (query.includes(t.toLowerCase())) matched.push(t);
  }

  return [...new Set(matched)];
}

function buildQueries(supertype, keywords, typeFilter) {
  const markFilter = STANDARD_MARKS.map(m => `regulationMark:${m}`).join(' OR ');
  const legalFilter = ` (${markFilter})`;
  const typeStr = typeFilter ? ` types:${typeFilter}` : '';
  const base = `supertype:${supertype}${typeStr}${legalFilter}`;
  const queries = [];

  if (keywords.length > 0) {
    queries.push(`${base} abilities.text:"${keywords[0]}"`);
    queries.push(`${base} attacks.text:"${keywords[0]}"`);
  }
  if (keywords.length > 1) {
    queries.push(`${base} abilities.text:"${keywords[1]}"`);
    queries.push(`${base} attacks.text:"${keywords[1]}"`);
  }
  if (keywords.length > 0) queries.push(`${base} rules:"${keywords[0]}"`);
  if (queries.length === 0) queries.push(base);

  return queries.slice(0, 5);
}

async function askClaude(query, cards, apiKey) {
  const sums = cards.map(c => ({
    id: c.id,
    name: c.name,
    supertype: c.supertype,
    subtypes: c.subtypes,
    types: c.types,
    abilities: (c.abilities || []).map(a => `[${a.type}] ${a.name}: ${a.text}`),
    attacks: (c.attacks || []).map(a => `${a.name}${a.damage ? '(' + a.damage + ')' : ''}: ${a.text || ''}`),
    rules: c.rules || [],
    set: c.setName
  }));

  const prompt = `You are a competitive Pokémon TCG expert. A Standard format player needs: "${query}"

Analyze each card's actual ability/attack/trainer text carefully. Return ONLY a JSON array (no markdown, no preamble), max 12 results sorted by relevance:
[{"id":"...","name":"...","reason":"1-2 sentences referencing the specific ability or attack name and text explaining exactly how this card fulfills the search intent","relevance":"high"|"medium"|"low"}]

Only include cards that genuinely match. If fewer than 3 match well, return only the ones that do.

Cards:
${JSON.stringify(sums, null, 1)}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error?.message || 'Anthropic API error');
  }

  const data = await r.json();
  const text = data.content.map(b => b.text || '').join('');
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  return Array.isArray(parsed) ? parsed : [];
}
