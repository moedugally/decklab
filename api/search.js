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
const CACHE_TTL = 60 * 60 * 24 * 30;
const NEGATIVE_THRESHOLD = 1;

// ── cache ─────────────────────────────────────────────────────────────────────

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

// ── query intelligence ─────────────────────────────────────────────────────────

const INTENT_PROMPT = `You are a competitive Pokémon TCG search engine. Analyze the user's query and return a JSON object (no markdown).

Query types:
- "named_pokemon": wants cards to SUPPORT a specific Pokémon (e.g. "heal crustle", "energy for charizard", "works with dragapult")
- "archetype": wants cards for a deck archetype (e.g. "lost box deck", "dragapult ex list")
- "counter": wants to beat/counter something (e.g. "beat charizard", "counter lost box")
- "synergy": wants cards that combo with a named card (e.g. "works with iron hands", "pairs with iono")
- "multi_constraint": has multiple simultaneous numeric/role requirements (e.g. "low energy high damage", "1 prize wall", "fast cheap attacker")
- "budget": wants cheaper alternatives (e.g. "budget boss orders")
- "general": simple role/mechanic searches

Return this exact JSON shape:
{
  "type": "<type>",
  "named_card": "<specific Pokémon/card name if present, else null>",
  "archetype_name": "<archetype name if type is archetype or counter, else null>",
  "constraints": ["<each distinct constraint for multi_constraint, else []>"],
  "criteria": {
    "minDamage": <minimum damage number for any single attack, or null>,
    "maxEnergyCost": <maximum convertedEnergyCost for that attack, or null>,
    "maxRetreatCost": <max retreat cost count, or null>,
    "excludeNames": ["<names of Pokémon/cards to EXCLUDE from results — always include named_card here for counter/named_pokemon queries>"],
    "requireSupertype": "<'pokemon'|'trainer'|'energy'|null>",
    "requireTypes": ["<energy types like 'Fire','Water' if specified, else []>"]
  },
  "rewritten_query": "<CRITICAL: describe the SOLUTION CARDS you're looking for, NOT the target Pokémon. For named_pokemon queries, describe the mechanic/effect needed (e.g. 'trainer cards and abilities that remove damage counters or restore HP, healing supporters, recovery items'). Never mention the target Pokémon's name in this field. 2-4 sentences about what the ideal result card does.>"
}

Examples:
- "heal crustle" → rewritten_query: "trainer cards and pokemon abilities that heal damage counters or restore HP to any pokemon. Recovery supporters, healing items, abilities that remove damage."
- "low energy high damage" → minDamage: 130, maxEnergyCost: 2, rewritten_query: "pokemon attacker with high damage output for minimal energy cost, efficient damage dealer, strong attack low cost"
- "1 energy attacker" → minDamage: 100, maxEnergyCost: 1
- "cheap attacker" → minDamage: 120, maxEnergyCost: 2
- IMPORTANT: "low energy" means maxEnergyCost 1 or 2 MAX. Never set maxEnergyCost above 2 for any "low energy" query.
- "counter lost box" → rewritten_query: "cards that disrupt lost zone strategies, prevent lost zone damage, path to the peak ability lock, prize denial counters"
- "heal mega kangaskhan" → excludeNames: ["Kangaskhan","Mega Kangaskhan"], rewritten_query: "healing trainer cards, damage counter removal, HP restoration supporters and items, recovery mechanics"

User query: `;

async function classifyQuery(query, archetypes) {
  const lq = query.trim().toLowerCase();

  // Fast path: pure TCG slang
  if (TCG_SLANG[lq]) {
    return {
      type: 'general',
      named_card: null,
      archetype_name: null,
      constraints: [],
      criteria: { minDamage: null, maxEnergyCost: null, maxRetreatCost: null, excludeNames: [], requireSupertype: null, requireTypes: [] },
      rewritten_query: `${query} ${TCG_SLANG[lq]}`
    };
  }

  const archetypeMatch = findArchetype(archetypes, lq);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content: INTENT_PROMPT + `"${query}"` }]
      })
    });
    const data = await r.json();
    const text = data.content?.map(b => b.text || '').join('') || '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!parsed.criteria) parsed.criteria = { minDamage: null, maxEnergyCost: null, maxRetreatCost: null, excludeNames: [], requireSupertype: null, requireTypes: [] };
    if (!parsed.criteria.excludeNames) parsed.criteria.excludeNames = [];

    if (archetypeMatch && (parsed.type === 'archetype' || parsed.type === 'counter')) {
      parsed._archetype = archetypeMatch;
    }
    return parsed;
  } catch {
    return {
      type: 'general',
      named_card: null,
      archetype_name: null,
      constraints: [],
      criteria: { minDamage: null, maxEnergyCost: null, maxRetreatCost: null, excludeNames: [], requireSupertype: null, requireTypes: [] },
      rewritten_query: query
    };
  }
}

// Look up a named Pokémon in the vector index to get its real attributes
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
    return results.find(c => c.name?.toLowerCase() === cardName.toLowerCase()) || results[0] || null;
  } catch { return null; }
}

async function buildNamedPokemonQuery(intent, originalQuery) {
  const cardData = await lookupCardData(intent.named_card);

  // rewritten_query describes the solution cards (e.g. "healing trainers, damage removal")
  // cardData traits are appended as context for what the target pokemon needs
  const base = intent.rewritten_query || originalQuery;

  if (!cardData) return base;

  const traits = [
    cardData.types?.length ? `${cardData.types.join('/')} type` : '',
    cardData.subtypes?.length ? cardData.subtypes.join(' ') : '',
    ...(cardData.abilities || []).map(a => `"${a.name}": ${a.text}`),
  ].filter(Boolean).join('. ');

  // Lead with the mechanic description, trail with target context
  return `${base} Compatible with: ${cardData.name}${traits ? ` (${traits})` : ''}.`;
}

function buildArchetypeQuery(intent) {
  const arch = intent._archetype;
  if (!arch) return intent.rewritten_query;
  const keyCards = (arch.cards || []).slice(0, 6).map(c => c.name).join(', ');
  const base = intent.type === 'counter'
    ? `Cards that counter or disrupt the ${arch.name} archetype. Key cards in that deck: ${keyCards}.`
    : `Support cards for the ${arch.name} archetype. Key cards: ${keyCards}.`;
  return `${base} ${intent.rewritten_query}`;
}

// ── structured code-level filtering (hard numeric constraints) ─────────────────

function applyStructuredFilters(cards, criteria) {
  if (!criteria) return cards;
  const { minDamage, maxEnergyCost, maxRetreatCost, excludeNames, requireSupertype, requireTypes } = criteria;

  return cards.filter(card => {
    // Exclude named cards (e.g. don't return Crustle when searching "heal crustle")
    if (excludeNames?.length) {
      const cardNameLower = card.name?.toLowerCase() || '';
      if (excludeNames.some(n => cardNameLower.includes(n.toLowerCase()))) return false;
    }

    // Supertype filter — strip diacritics so "Pokémon" === "pokemon"
    if (requireSupertype) {
      const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/̀-ͯ/g, '').replace(/[^a-z]/g, '');
      if (norm(card.supertype) !== norm(requireSupertype)) return false;
    }

    // Energy type filter
    if (requireTypes?.length) {
      if (!requireTypes.some(t => (card.types || []).includes(t))) return false;
    }

    // Retreat cost filter
    if (maxRetreatCost !== null && maxRetreatCost !== undefined) {
      const retreat = card.retreatCost?.length ?? 99;
      if (retreat > maxRetreatCost) return false;
    }

    // Attack damage + energy cost filter — card passes if ANY attack satisfies BOTH constraints
    const hasDamageConstraint = minDamage !== null && minDamage !== undefined;
    const hasCostConstraint = maxEnergyCost !== null && maxEnergyCost !== undefined;

    if (hasDamageConstraint || hasCostConstraint) {
      const attacks = card.attacks || [];
      // If it's a trainer/energy with no attacks, only fail if we specifically need damage
      if (!attacks.length) return !hasDamageConstraint;

      const qualifies = attacks.some(a => {
        const dmg = parseInt((a.damage || '').replace(/[^0-9]/g, '')) || 0;
        // convertedEnergyCost may be stored as string in vector metadata
        const rawCost = a.convertedEnergyCost;
        const cost = rawCost !== null && rawCost !== undefined
          ? parseInt(rawCost, 10)
          : (Array.isArray(a.cost) ? a.cost.length : 0);
        const damageOk = !hasDamageConstraint || dmg >= minDamage;
        const costOk = !hasCostConstraint || cost <= maxEnergyCost;
        return damageOk && costOk;
      });

      if (!qualifies) return false;
    }

    return true;
  });
}

// ── re-ranking (semantic pass after hard filters) ─────────────────────────────

async function rerank(originalQuery, intent, cards) {
  if (!cards.length) return cards;

  const cardSummaries = cards.map(c => ({
    id: c.id,
    name: c.name,
    supertype: c.supertype,
    subtypes: c.subtypes,
    types: c.types,
    abilities: (c.abilities || []).map(a => `[${a.type}] ${a.name}: ${a.text}`),
    attacks: (c.attacks || []).map(a =>
      `${a.name} (cost:${a.convertedEnergyCost ?? a.cost?.length ?? '?'}, dmg:${a.damage || '0'}): ${a.text || ''}`
    ),
    rules: c.rules || [],
    retreatCost: c.retreatCost?.length ?? 0,
  }));

  const constraintNote = intent.constraints?.length
    ? `ALL of these constraints must be satisfied simultaneously: ${intent.constraints.join('; ')}. Exclude any card satisfying only some.`
    : '';

  const prompt = `You are a competitive Pokémon TCG expert. A player searched: "${originalQuery}"
Intent: ${intent.type}${intent.named_card ? ` (target: ${intent.named_card})` : ''}${intent.archetype_name ? ` (archetype: ${intent.archetype_name})` : ''}
${constraintNote}

Return ONLY the IDs of cards that genuinely fulfill the search intent, best first. Be strict.
Return ONLY a JSON array of IDs, no markdown: ["id1","id2",...]

Candidates:
${JSON.stringify(cardSummaries, null, 1)}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
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

    const cardMap = new Map(cards.map(c => [c.id, c]));
    const ranked = ids.map(id => cardMap.get(id)).filter(Boolean);
    // Only return what the re-ranker confirmed — don't append unranked cards
    // If re-ranker returned nothing, fall back to original set
    return ranked.length > 0 ? ranked : cards;
  } catch {
    return cards;
  }
}

// ── main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });

  const typeFilter = req.body.type || '';
  const cacheKey = `v6:search:standard:${typeFilter.toLowerCase()}:${query.trim().toLowerCase()}`;

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

    // ── classify query (fetch archetypes only if likely needed) ──
    // Do a fast pre-check: only pull Limitless data for archetype/counter queries
    const lqPre = query.toLowerCase();
    const likelyNeedsArchetypes = /\b(deck|list|build|counter|beat|against)\b/.test(lqPre);
    const archetypes = likelyNeedsArchetypes ? await getArchetypes().catch(() => []) : [];
    const intent = await classifyQuery(query, archetypes);

    // ── build enriched search query + vector search in parallel ──
    // For named_pokemon we need card data first, so those run sequentially.
    // For everything else, start vector search immediately with the rewritten query.
    let searchQuery = intent.rewritten_query || query;

    if (intent.type === 'named_pokemon' && intent.named_card) {
      searchQuery = await buildNamedPokemonQuery(intent, query);
    } else if ((intent.type === 'archetype' || intent.type === 'counter') && intent._archetype) {
      searchQuery = buildArchetypeQuery(intent);
    }

    // ── vector search — wider net for numeric constraint queries ──
    const topK = intent.type === 'multi_constraint' ? 250 : 100;
    const cards = await vectorSearch(searchQuery, typeFilter, topK);
    if (!cards.length) return res.status(200).json({ matches: [], _debug: 'no vector results' });

    // ── dedupe ──
    const seen = new Set();
    const deduped = cards.filter(c => {
      const norm = (s) => (s || '').toLowerCase().replace('é', 'e');
      const isPokemon = !['trainer', 'energy'].includes(norm(c.supertype));
      const key = isPokemon ? `${c.name}|${c.setName}` : c.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // ── hard structured filters (numeric constraints, exclusions) ──
    // Two-level fallback: first try full criteria, then drop numeric constraints,
    // then abandon all filters if needed — always return at least the deduped set
    const hardFiltered = (() => {
      const f1 = applyStructuredFilters(deduped, intent.criteria);
      if (f1.length > 0) return f1;
      const f2 = applyStructuredFilters(deduped, { ...intent.criteria, minDamage: null, maxEnergyCost: null, maxRetreatCost: null });
      if (f2.length > 0) return f2;
      return deduped; // abandon all filters rather than return empty
    })();

    // ── semantic re-ranking (skip for general queries — saves ~2s) ──
    const needsRerank = ['named_pokemon', 'multi_constraint', 'counter', 'synergy', 'budget'].includes(intent.type);
    const reranked = needsRerank ? await rerank(query, intent, hardFiltered) : hardFiltered;

    // ── feedback filter ──
    const filtered = await filterFlagged(query, reranked);

    // Final safety: if feedback filter wiped everything, use pre-filter results
    const safeFiltered = filtered.length > 0 ? filtered : reranked;

    const results = safeFiltered.map(c => ({
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

    if (results.length > 0) cacheSet(cacheKey, results);
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
    res.setHeader('X-Cache', 'MISS');
    const _debug = {
      intent: intent.type,
      criteria: intent.criteria,
      vector: cards.length,
      deduped: deduped.length,
      hardFiltered: hardFiltered.length,
      reranked: reranked.length,
      final: results.length,
    };
    return res.status(200).json({ matches: results, _debug });

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

async function vectorSearch(query, typeFilter, topK = 100) {
  if (!VECTOR_URL || !VECTOR_TOKEN) return [];
  const r = await fetch(`${VECTOR_URL}/query-data`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${VECTOR_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: query, topK, includeMetadata: true })
  });
  if (!r.ok) return [];
  const data = await r.json();
  let results = (data.result || []).map(r => r.metadata).filter(Boolean);
  if (typeFilter) results = results.filter(c => (c.types || []).includes(typeFilter));
  results = results.filter(c => STANDARD_MARKS.includes(c.regulationMark));
  return results;
}
