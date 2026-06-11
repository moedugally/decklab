// Update STANDARD_MARKS each May rotation (3 most recent regulation letters)
const STANDARD_MARKS = ['H', 'I', 'J'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query, format } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Missing query' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    // Step 1: Smart card fetching based on query intent
    const cards = await fetchSmartCards(query, format, req.body.type || '');

    if (!cards.length) {
      return res.status(200).json({ matches: [] });
    }

    // Step 2: Ask Claude to reason about which cards match
    const matches = await askClaude(query, cards, format, apiKey);
    
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
    return res.status(200).json({ matches });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}

async function fetchSmartCards(query, format, typeFilter) {
  const lq = query.toLowerCase();

  // Determine supertype
  let supertype = 'pokemon';
  if (/\b(trainer|supporter|item|stadium|tool)\b/.test(lq)) supertype = 'trainer';
  else if (/\benergy card\b/.test(lq)) supertype = 'energy';

  // Extract keywords to search card text directly
  const keywords = extractKeywords(lq);

  // Build multiple targeted queries and merge results
  const queries = buildQueries(supertype, keywords, format, typeFilter);
  
  const cardMap = new Map();
  
  await Promise.all(queries.map(async (q) => {
    try {
      const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=30`;
      const r = await fetch(url);
      if (!r.ok) return;
      const data = await r.json();
      (data.data || []).forEach(c => cardMap.set(c.id, c));
    } catch(e) {
      // silently skip failed sub-queries
    }
  }));

  let results = Array.from(cardMap.values());

  // Hard filter: for standard, only keep cards with a legal regulation mark
  if (format === 'standard') {
    results = results.filter(c => STANDARD_MARKS.includes(c.regulationMark));
  }

  return results.slice(0, 60);
}

function extractKeywords(query) {
  // Map natural language concepts to card text keywords
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
    if (concepts.some(c => new RegExp(c).test(query))) {
      matched.push(...keywords);
    }
  }

  // Also extract energy types mentioned
  const types = ['Fire','Water','Grass','Lightning','Psychic','Fighting','Darkness','Metal','Dragon','Fairy','Colorless'];
  for (const t of types) {
    if (query.includes(t.toLowerCase())) matched.push(t);
  }

  return [...new Set(matched)];
}

function buildQueries(supertype, keywords, format, typeFilter) {
  const markFilter = STANDARD_MARKS.map(m => `regulationMark:${m}`).join(' OR ');
  const legalFilter = format === 'standard' ? ` (${markFilter})` :
                      format === 'expanded' ? ' legalities.expanded:legal' : '';
  const typeStr = typeFilter ? ` types:${typeFilter}` : '';
  const base = `supertype:${supertype}${typeStr}${legalFilter}`;
  
  const queries = [];

  // Query 1: Search abilities text
  if (keywords.length > 0) {
    const kw = keywords[0];
    queries.push(`${base} abilities.text:"${kw}"`);
  }

  // Query 2: Search attacks text  
  if (keywords.length > 0) {
    const kw = keywords[0];
    queries.push(`${base} attacks.text:"${kw}"`);
  }

  // Query 3: Search with second keyword if available
  if (keywords.length > 1) {
    queries.push(`${base} abilities.text:"${keywords[1]}"`);
    queries.push(`${base} attacks.text:"${keywords[1]}"`);
  }

  // Query 4: Rules text (for trainers/special rules)
  if (keywords.length > 0) {
    queries.push(`${base} rules:"${keywords[0]}"`);
  }

  // Fallback: broad supertype query if no keywords matched
  if (queries.length === 0) {
    queries.push(`${base}&pageSize=40`);
  }

  return queries.slice(0, 5); // max 5 parallel queries
}

async function askClaude(query, cards, format, apiKey) {
  const sums = cards.map(c => ({
    id: c.id,
    name: c.name,
    supertype: c.supertype,
    subtypes: c.subtypes,
    types: c.types,
    abilities: (c.abilities || []).map(a => `[${a.type}] ${a.name}: ${a.text}`),
    attacks: (c.attacks || []).map(a => `${a.name}(${a.damage || '–'}): ${a.text || ''}`),
    rules: c.rules || [],
    set: c.set?.name
  }));

  const fmtNote = format === 'standard' ? 'Standard' : format === 'expanded' ? 'Expanded' : 'any format';

  const prompt = `You are a competitive Pokémon TCG expert. A ${fmtNote} player needs: "${query}"

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
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error?.message || 'Anthropic API error');
  }

  const data = await r.json();
  const text = data.content.map(b => b.text || '').join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}
