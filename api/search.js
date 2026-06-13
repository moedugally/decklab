import { getArchetypes, findArchetype } from './archetypes.js';

// Update STANDARD_MARKS each May rotation (3 most recent regulation letters)
const STANDARD_MARKS = ['H', 'I', 'J'];

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
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CACHE_TTL = 60 * 60 * 24 * 30; // 30 days
const NEGATIVE_THRESHOLD = 1;

// ── cache ────────────────────────────────────────────────────────────────────

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

// ── query intelligence ────────────────────────────────────────────────────────

const INTENT_PROMPT = `You are a competitive Pokémon TCG search engine. Analyze the user's query and return a JSON object (no markdown).

Query types and how to handle them:
- "named_pokemon": query mentions a specific Pokémon by name that the user wants to SUPPORT or USE (e.g. "heal crustle", "energy for charizard", "works with dragapult")
- "archetype": query refers to a deck archetype or deck list (e.g. "lost box deck", "dragapult ex list", "regidrago build")
- "counter": query wants to beat or counter something (e.g. "beat charizard", "counter lost box", "good against giratina")
- "synergy": query wants cards that combo with a named card (e.g. "works with iron hands", "pairs with fezandipiti", "good with iono")
- "multi_constraint": query has multiple simultaneous requirements (e.g. "low energy high damage", "1 prize wall", "fast cheap attacker")
- "budget": query wants cheaper alternatives (e.g. "budget boss orders", "free alternative to ultra ball")
- "general": everything else — simple role/mechanic searches

Return:
{
  "type": "<one of the types above>",
  "named_card": "<the specific Pokémon or card name if present, else null>",
  "archetype_name": "<archetype name if type is archetype or counter, else null>",
  "constraints": ["<list each distinct constraint for multi_constraint, else []>"],
  "rewritten_query": "<an expanded, precise search query using TCG mechanic language that will find the best vector matches. Be specific about mechanics, effects, and roles. 2-4 sentences.>"
}

User query: `;

async function classifyQuery(query, archetypes) {
  // Fast path: pure slang — no need to call Claude
  const lq = query.trim().toLowerCase();
  if (TCG_SLANG[lq]) {
    return {
      type: 'general',
      named_card: null,
      archetype_name: null,
      constraints: [],
      rewritten_query: `${query} ${TCG_SLANG[lq]}`
    };
  }

  // Check if it matches a known archetype before calling Claude
  const archetypeMatch = findArchetype(archetypes, lq);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: INTENT_PROMPT + `"${query}"` }]
      })
    });
    const data = await r.json();
    const text = data.content?.map(b => b.text || '').join('') || '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    // If Claude found an archetype name but we already have a Limitless match, attach it
    if (archetypeMatch && (parsed.type === 'archetype' || parsed.type === 'counter')) {
      parsed._archetype = archetypeMatch;
    }

    return parsed;
  } catch {
    // Fallback: treat as general with slang expansion
    return {
      type: 'general',
      named_card: null,
      archetype_name: null,
      constraints: [],
      rewritten_query: query
    };
  }
}

// Look up a named Pokémon card in the vector index to get its real attributes
async function lookupCardData(cardName) {
  if (!VECTOR_URL || !VECTOR_TOKEN) return null;
  try {
    const r = await fetch(`${VECTOR_URL}/query-data`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${VECTOR_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: cardName, topK: 5, includeMetadata: true })
    });
    const data = await r.json();
    const results = (data.result || []).map(r => r.metadata).filter(Boolean);
    // Find the best exact name match
    const exact = results.find(c => c.name?.toLowerCase() === cardName.toLowerCase());
    return exact || results[0] || null;
  } catch { return null; }
}

// Build an enriched query for named_pokemon intent using the card's actual data
async function buildNamedPokemonQuery(intent, originalQuery) {
  const cardData = await lookupCardData(intent.named_card);
  if (!cardData) return intent.rewritten_query;

  const traits = [
    cardData.types?.length ? `${cardData.types.join('/')} type` : '',
    cardData.subtypes?.length ? cardData.subtypes.join(' ') : '',
    cardData.hp ? `${cardData.hp} HP` : '',
    ...(cardData.abilities || []).map(a => `ability "${a.name}": ${a.text}`),
    ...(cardData.attacks || []).map(a => `attack "${a.name}" (${a.damage || '–'}): ${a.text || ''}`),
  ].filter(Boolean).join('. ');

  return `${intent.rewritten_query} Target Pokémon details — ${cardData.name}: ${traits}`;
}

// Build an enriched query for archetype/counter intents using Limitless data
function buildArchetypeQuery(intent, originalQuery) {
  const arch = intent._archetype;
  if (!arch) return intent.rewritten_query;

  const keyCards = (arch.cards || []).slice(0, 6).map(c => c.name).join(', ');
  const base = intent.type === 'counter'
    ? `Cards that counter or disrupt the ${arch.name} archetype. Key cards in that deck: ${keyCards}.`
    : `Support cards for the ${arch.name} archetype. Key cards: ${keyCards}.`;

  return `${base} ${intent.rewritten_query}`;
}

// Re-rank candidates against the original query + intent
async function rerank(originalQuery, intent, cards) {
  if (!cards.length) return cards;

  const cardSummaries = cards.map(c => ({
    id: c.id,
    name: c.name,
    supertype: c.supertype,
    subtypes: c.subtypes,
    types: c.types,
    abilities: (c.abilities || []).map(a => `[${a.type}] ${a.name}: ${a.text}`),
    attacks: (c.attacks || []).map(a => `${a.name}${a.damage ? ' (' + a.damage + ')' : ''}: ${a.text || ''}`),
    rules: c.rules || [],
  }));

  const constraintNote = intent.constraints?.length
    ? `This query has multiple simultaneous constraints that ALL must be satisfied: ${intent.constraints.join('; ')}. Exclude any card that satisfies only some constraints.`
    : '';

  const prompt = `You are a competitive Pokémon TCG expert. A player searched: "${originalQuery}"
Query intent: ${intent.type}${intent.named_card ? ` (target: ${intent.named_card})` : ''}${intent.archetype_name ? ` (archetype: ${intent.archetype_name})` : ''}
${constraintNote}

From the candidates below, return ONLY the IDs of cards that genuinely fulfill the search intent, in order of relevance (best first). Be strict — exclude partial matches.

Return ONLY a JSON array of IDs, no markdown: ["id1", "id2", ...]

Candidates:
${JSON.stringify(cardSummaries, null, 1)}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    const text = data.content?.map(b => b.text || '').join('') || '';
    const ids = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!Array.isArray(ids)) return cards;

    // Re-order cards to match ranked order, drop excluded ones
    const idSet = new Set(ids);
    const cardMap = new Map(cards.map(c => [c.id, c]));
    const ranked = ids.map(id => cardMap.get(id)).filter(Boolean);
    // Append any cards not mentioned by reranker at the end (safety net)
    const rest = cards.filter(c => !idSet.has(c.id));
    return [...ranked, ...rest];
  } catch {
    return cards; // non-fatal: return original order
  }
}

// ── main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });

  const typeFilter = req.body.type || '';
  const cacheKey = `v4:search:standard:${typeFilter.toLowerCase()}:${query.trim().toLowerCase()}`;

  try {
    // ── cache hit ──
    const cached = await cacheGet(cacheKey);
    if (cached) {
      const filtered = await filterFlagged(query, cached);
      const pinned = await getPinned(query);
      const filteredPinned = await filterFlagged(query, pinned);
      const existingIds = new Set(filtered.map(m => m.id));
      for (const c of filteredPinned) {
        if (!existingIds.has(c.id)) filtered.push({ id: c.id, name: c.name, relevance: 'high', card: normalizeCard(c) });
      }
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json({ matches: filtered });
    }

    // ── query intelligence ──
    const [archetypes, intent] = await Promise.all([
      getArchetypes().catch(() => []),
      Promise.resolve(null) // placeholder, classified below with archetypes
    ]);
    const classifiedIntent = await classifyQuery(query, archetypes);

    // ── build expanded search query ──
    let searchQuery = classifiedIntent.rewritten_query || query;

    if (classifiedIntent.type === 'named_pokemon' && classifiedIntent.named_card) {
      searchQuery = await buildNamedPokemonQuery(classifiedIntent, query);
    } else if ((classifiedIntent.type === 'archetype' || classifiedIntent.type === 'counter') && classifiedIntent._archetype) {
      searchQuery = buildArchetypeQuery(classifiedIntent, query);
    }

    // ── vector search ──
    const cards = await vectorSearch(searchQuery, typeFilter);
    if (!cards.length) return res.status(200).json({ matches: [] });

    // ── dedupe ──
    const seen = new Set();
    const deduped = cards.filter(c => {
      const isPokemon = !['trainer', 'energy'].includes(c.supertype?.toLowerCase());
      const key = isPokemon ? `${c.name}|${c.setName}` : c.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // ── re-rank (enforces multi-constraint AND-logic, drops poor matches) ──
    const reranked = await rerank(query, classifiedIntent, deduped);

    // ── feedback filter ──
    const filtered = await filterFlagged(query, reranked);

    const results = filtered.map(c => ({
      id: c.id,
      name: c.name,
      relevance: 'high',
      card: normalizeCard(c)
    }));

    // ── pinned cards ──
    const pinned = await getPinned(query);
    const filteredPinned = await filterFlagged(query, pinned);
    const existingIds = new Set(results.map(m => m.id));
    for (const c of filteredPinned) {
      if (!existingIds.has(c.id)) results.push({ id: c.id, name: c.name, relevance: 'high', card: normalizeCard(c) });
    }

    cacheSet(cacheKey, results);

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json({ matches: results });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

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
    const r = await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(keys.map(k => ['GET', k]))
    });
    const results = await r.json();
    return cards.filter((_, i) => parseInt(results[i]?.result || '0', 10) < NEGATIVE_THRESHOLD);
  } catch { return cards; }
}

async function vectorSearch(query, typeFilter) {
  if (!VECTOR_URL || !VECTOR_TOKEN) return [];

  const r = await fetch(`${VECTOR_URL}/query-data`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${VECTOR_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: query, topK: 100, includeMetadata: true })
  });

  if (!r.ok) return [];

  const data = await r.json();
  let results = (data.result || []).map(r => r.metadata).filter(Boolean);
  if (typeFilter) results = results.filter(c => (c.types || []).includes(typeFilter));
  results = results.filter(c => STANDARD_MARKS.includes(c.regulationMark));
  return results;
}
