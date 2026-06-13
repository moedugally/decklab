import { getArchetypes, findArchetype } from './archetypes.js';

const STANDARD_MARKS = ['H', 'I', 'J'];

const TCG_SLANG = {
  // Control / Disruption
  'gust':              'switch opponent active pokemon with benched pokemon boss orders gust effect',
  'gust effect':       'switch opponent active pokemon with benched pokemon boss orders',
  'mill':              'discard cards from opponent deck deck-out win condition milling',
  'hand disruption':   'reduce opponent hand size discard cards iono supporter hand reset',
  'lock':              'prevent opponent playing cards ability lock item lock stadium lock control',
  'ability lock':      'shut off pokemon abilities path to the peak nullify iono ability block',
  'item lock':         'prevent trainer item cards from being played item block control',
  'stadium lock':      'prevent stadiums from being played lock control disruption',
  // Mobility
  'pivot':             'switch your active pokemon with benched free retreat cost zero escape rope',
  'free retreat':      'retreat cost zero switch active benched pivot no energy cost',
  'switch':            'switch active benched pokemon mobility pivot free retreat escape rope',
  // Defense
  'wall':              'reduce damage taken prevent damage high hp damage reduction defender ability',
  'stall':             'stall strategy defensive high hp wall 1 prize prevent damage time out',
  'tank':              'high hp damage reduction wall survive multiple hits bulky defender',
  'bench protection':  'prevent damage to benched pokemon bench barrier defender protection shield',
  'damage reduction':  'reduce incoming damage wall defender ability resistance',
  // Offense
  'snipe':             'damage benched pokemon directly bench sniper targeted bench damage',
  'spread':            'damage all pokemon on opponent field bench spread attack',
  'nuke':              'high damage attack one shot knock out ohko burst finisher',
  'ohko':              'one hit knock out high damage 280+ burst attacker finisher',
  'burst':             'high damage low energy one shot attacker efficient knockout',
  'chip':              'small damage chip shot soften targets weaken setup attacker',
  // Energy
  'accelerate':        'attach energy from discard pile hand acceleration turbo fast setup',
  'turbo':             'attach energy quickly energy acceleration fast setup multiple per turn',
  'energy acceleration': 'attach energy from discard hand deck multiple per turn turbo setup',
  // Recovery
  'reborn':            'revive pokemon from discard pile resurrection recovery bring back',
  'recovery':          'retrieve cards from discard pile restoration salvage',
  'heal':              'remove damage counters restore HP healing recovery ice cream moomoo',
  // Drawing / Searching
  'draw supporter':    'draw cards from deck supporter professor iono lillie draw power',
  'search':            'search deck for pokemon trainer energy ball nest hyper ultra',
  'consistency':       'draw search thin deck set up reliably supporter ball consistency',
  'thin':              'deck thinning draw consistency search supporter',
  // Roles
  '1 prize':           'single prize pokemon basic stage 1 stage 2 non-ex non-v non-vmax one prize attacker',
  'one prize':         'single prize pokemon non-ex non-v non-vmax basic stage 1 attacker',
  '2 prize':           'two prize ex v vmax vstar pokemon ex giver',
  'two prize':         'two prize ex v vmax vstar pokemon',
  'tech':              'tech option situational counter single copy toolbox silver bullet',
  'staple':            'staple must-play every deck universal consistency core card',
  'finisher':          'high damage closing attacker knock out last prize game ender',
  'setup':             'bench setup ability draw search evolution chain preparation',
  'tempo':             'fast aggressive tempo attacker quick setup prize trade efficiency',
};

const KV_URL    = process.env.KV_REST_API_URL;
const KV_TOKEN  = process.env.KV_REST_API_TOKEN;
const VECTOR_URL   = process.env.UPSTASH_VECTOR_REST_URL;
const VECTOR_TOKEN = process.env.UPSTASH_VECTOR_REST_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CACHE_TTL = 60 * 60 * 24 * 30;
const NEGATIVE_THRESHOLD = 1;
const STATS_KEY = 'statsindex';

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
  fetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', CACHE_TTL]])
  }).catch(() => {});
}


// ── stat store ────────────────────────────────────────────────────────────────
// Pre-built index of every card's numeric stats (see api/build-stats.js).
// Used to augment vector search for numeric constraint queries — ensures cards
// like "Greninja ex (170 dmg / 2 energy)" are never missed due to semantic ranking.

async function getStatStore() {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(STATS_KEY)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}

function statStoreFilter(store, criteria) {
  if (!store || !criteria) return [];
  const { minDamage, maxEnergyCost, maxRetreatCost, requireSupertype, requireTypes } = criteria;

  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');

  return store.filter(c => {
    if (requireSupertype && norm(c.supertype) !== norm(requireSupertype)) return false;
    if (requireTypes?.length && !requireTypes.some(t => (c.types || []).includes(t))) return false;
    if (maxRetreatCost !== null && maxRetreatCost !== undefined && c.retreatCount > maxRetreatCost) return false;

    const hasDmg  = minDamage !== null && minDamage !== undefined;
    const hasCost = maxEnergyCost !== null && maxEnergyCost !== undefined;
    if (!hasDmg && !hasCost) return true;
    if (!c.maxDamage && hasDmg) return false;

    const dmgOk  = !hasDmg  || c.maxDamage >= minDamage;
    const costOk = !hasCost || c.minEnergyForBestAtk <= maxEnergyCost;
    return dmgOk && costOk;
  });
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
    "excludeNames": ["<names to EXCLUDE — always include named_card here for counter/named_pokemon queries>"],
    "requireSupertype": "<'pokemon'|'trainer'|'energy'|null>",
    "requireTypes": ["<energy types like 'Fire','Water' if specified, else []>"],
    "requireColorlessAttacksOnly": <true if ALL attacks must use only Colorless energy (no typed energy at all), else false>,
    "requireAbility": <true if card must have at least one Ability, else false>,
    "requireStage": "<'Basic'|'Stage 1'|'Stage 2'|'VMAX'|'VSTAR'|null — only set if stage is explicitly mentioned>",
    "excludePokemonRule": <true if query says '1 prize', 'non-ex', 'non-V', 'single prize' — excludes ex/V/VMAX/VSTAR, else false>,
    "requirePokemonRule": <true if query says '2 prize', 'ex only', 'V pokemon' — requires rule box, else false>,
    "cardTextContains": "<exact mechanic phrase to find in ability/attack text, e.g. 'move damage counters', 'discard energy', 'search your deck' — or null>"
  },
  "rewritten_query": "<CRITICAL: describe the SOLUTION CARDS you're looking for. Include the specific card text pattern if relevant. 2-4 sentences.>",
  "alternative_queries": ["<alternate phrasing — stat/numeric focus>", "<alternate phrasing — role/synergy focus>"]
}

Rules:
- "low energy" → maxEnergyCost 1 or 2 MAX. Never above 2.
- "cheap attacker" → minDamage: 120, maxEnergyCost: 2
- "1 energy attacker" → minDamage: 100, maxEnergyCost: 1
- "heal <pokemon>" → excludeNames: ["<pokemon>"], rewritten_query describes healing cards NOT the pokemon
- "only colorless attacks" / "colorless cost" / "splashable attacker" → requireColorlessAttacksOnly: true
- "1 prize" / "non-ex" / "non-V" / "single prize" → excludePokemonRule: true
- "move damage" / "transfer damage counters" → cardTextContains: "move damage counters"
- "discard energy from opponent" → cardTextContains: "discard an Energy"
- "search deck for" → cardTextContains: "search your deck"
- alternative_queries must be genuinely different angles

Examples:
- "heal crustle" → type: named_pokemon, excludeNames: ["Crustle"], rewritten_query: "trainer cards and abilities that remove damage counters or restore HP."
- "low energy high damage attacker" → type: multi_constraint, minDamage: 130, maxEnergyCost: 2, rewritten_query: "pokemon with high damage output for minimal energy cost"
- "grass pokemon with only colorless attacks" → requireSupertype: "pokemon", requireTypes: ["Grass"], requireColorlessAttacksOnly: true, rewritten_query: "Grass type pokemon whose attacks only require Colorless energy, no typed energy cost, splashable attacker"
- "move damage from my pokemon to opponents pokemon" → cardTextContains: "move damage counters", rewritten_query: "ability or attack that moves or transfers damage counters from your pokemon to opponent's pokemon. Damage counter manipulation, redirect damage."
- "1 prize attacker" → excludePokemonRule: true, requireSupertype: "pokemon", rewritten_query: "single prize non-ex non-V attacker"
- "pokemon with an ability" → requireAbility: true, requireSupertype: "pokemon"

User query: `;

async function classifyQuery(query, archetypes) {
  const lq = query.trim().toLowerCase();

  if (TCG_SLANG[lq]) {
    return {
      type: 'general', named_card: null, archetype_name: null, constraints: [],
      criteria: { minDamage: null, maxEnergyCost: null, maxRetreatCost: null, excludeNames: [], requireSupertype: null, requireTypes: [] },
      rewritten_query: `${query} ${TCG_SLANG[lq]}`,
      alternative_queries: [],
    };
  }

  // Expand slang terms found within a longer query
  let expandedQuery = query;
  for (const [slang, expansion] of Object.entries(TCG_SLANG)) {
    if (lq.includes(slang)) {
      expandedQuery = `${query} ${expansion}`;
      break;
    }
  }

  const archetypeMatch = findArchetype(archetypes, lq);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        messages: [{ role: 'user', content: INTENT_PROMPT + `"${expandedQuery}"` }]
      })
    });
    const data = await r.json();
    const text = data.content?.map(b => b.text || '').join('') || '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!parsed.criteria) parsed.criteria = {};
    const c = parsed.criteria;
    if (!c.excludeNames)               c.excludeNames               = [];
    if (!c.requireTypes)               c.requireTypes               = [];
    if (c.requireSupertype == null)    c.requireSupertype           = null;
    if (c.requireColorlessAttacksOnly == null) c.requireColorlessAttacksOnly = false;
    if (c.requireAbility == null)      c.requireAbility             = false;
    if (c.requireStage == null)        c.requireStage               = null;
    if (c.excludePokemonRule == null)  c.excludePokemonRule         = false;
    if (c.requirePokemonRule == null)  c.requirePokemonRule         = false;
    if (c.cardTextContains == null)    c.cardTextContains           = null;
    if (!parsed.alternative_queries)   parsed.alternative_queries   = [];

    if (archetypeMatch && (parsed.type === 'archetype' || parsed.type === 'counter')) {
      parsed._archetype = archetypeMatch;
    }
    return parsed;
  } catch {
    return {
      type: 'general', named_card: null, archetype_name: null, constraints: [],
      criteria: { minDamage: null, maxEnergyCost: null, maxRetreatCost: null, excludeNames: [], requireSupertype: null, requireTypes: [] },
      rewritten_query: expandedQuery,
      alternative_queries: [],
    };
  }
}

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
  const base = intent.rewritten_query || originalQuery;
  if (!cardData) return base;
  const traits = [
    cardData.types?.length ? `${cardData.types.join('/')} type` : '',
    cardData.subtypes?.length ? cardData.subtypes.join(' ') : '',
    ...(cardData.abilities || []).map(a => `"${a.name}": ${a.text}`),
  ].filter(Boolean).join('. ');
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

// ── Reciprocal Rank Fusion ────────────────────────────────────────────────────
// Merges multiple ranked result sets. Cards appearing in multiple sets score
// higher. k=60 is the standard RRF constant (dampens top-rank dominance).

function mergeRRF(resultSets, k = 60) {
  const scores  = new Map();
  const cardById = new Map();
  for (const results of resultSets) {
    results.forEach((card, rank) => {
      scores.set(card.id, (scores.get(card.id) || 0) + 1 / (k + rank + 1));
      if (!cardById.has(card.id)) cardById.set(card.id, card);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => cardById.get(id));
}

// ── structured filters ────────────────────────────────────────────────────────

function applyStructuredFilters(cards, criteria) {
  if (!criteria) return cards;
  const {
    minDamage, maxEnergyCost, maxRetreatCost,
    excludeNames, requireSupertype, requireTypes,
    requireColorlessAttacksOnly, requireAbility, requireStage,
    excludePokemonRule, requirePokemonRule, cardTextContains,
  } = criteria;

  const norm      = s => (s || '').toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
  const textOf    = s => (s || '').toLowerCase();
  const hasRule   = card => (card.rules || []).some(r =>
    /\bex\b|v\b|vmax\b|vstar\b|restored\b/i.test(r)
  );

  return cards.filter(card => {
    // Name exclusions
    if (excludeNames?.length) {
      const n = card.name?.toLowerCase() || '';
      if (excludeNames.some(ex => n.includes(ex.toLowerCase()))) return false;
    }

    // Supertype (Pokémon / Trainer / Energy)
    if (requireSupertype && norm(card.supertype) !== norm(requireSupertype)) return false;

    // Energy type filter
    if (requireTypes?.length && !requireTypes.some(t => (card.types || []).includes(t))) return false;

    // Stage filter (Basic / Stage 1 / Stage 2 / VMAX / VSTAR)
    if (requireStage) {
      if (!(card.subtypes || []).some(s => norm(s) === norm(requireStage))) return false;
    }

    // Prize / rule-box filters
    if (excludePokemonRule && hasRule(card)) return false;
    if (requirePokemonRule && !hasRule(card)) return false;

    // Must have at least one Ability
    if (requireAbility && !(card.abilities || []).length) return false;

    // Retreat cost
    if (maxRetreatCost !== null && maxRetreatCost !== undefined) {
      if ((card.retreatCost?.length ?? 99) > maxRetreatCost) return false;
    }

    // All attacks must use only Colorless energy (no typed energy)
    if (requireColorlessAttacksOnly) {
      const attacks = card.attacks || [];
      // Trainers/Energy with no attacks — exclude unless explicitly a trainer search
      if (!attacks.length) return false;
      const allColorless = attacks.every(a =>
        (a.cost || []).every(c => c === 'Colorless')
      );
      if (!allColorless) return false;
    }

    // Card text contains a specific mechanic phrase (abilities OR attacks OR rules)
    if (cardTextContains) {
      const needle = textOf(cardTextContains);
      const abilityText  = (card.abilities || []).map(a => textOf(a.text)).join(' ');
      const attackText   = (card.attacks || []).map(a => textOf(a.text)).join(' ');
      const rulesText    = (card.rules || []).map(textOf).join(' ');
      const combined     = `${abilityText} ${attackText} ${rulesText}`;
      if (!combined.includes(needle)) return false;
    }

    // Attack damage + energy cost — card passes if ANY attack satisfies BOTH
    const hasDmg  = minDamage !== null && minDamage !== undefined;
    const hasCost = maxEnergyCost !== null && maxEnergyCost !== undefined;
    if (!hasDmg && !hasCost) return true;

    const attacks = card.attacks || [];
    if (!attacks.length) return !hasDmg;

    return attacks.some(a => {
      const dmg  = parseInt((a.damage || '').replace(/[^0-9]/g, '')) || 0;
      const raw  = a.convertedEnergyCost;
      const cost = raw !== null && raw !== undefined
        ? parseInt(raw, 10)
        : (Array.isArray(a.cost) ? a.cost.length : 0);
      return (!hasDmg || dmg >= minDamage) && (!hasCost || cost <= maxEnergyCost);
    });
  });
}

// ── positive feedback boost ───────────────────────────────────────────────────

async function getPositiveIds(query, cardIds) {
  if (!KV_URL || !KV_TOKEN || !cardIds.length) return new Set();
  try {
    const keys = cardIds.map(id => `feedback:${query.trim().toLowerCase()}:${id}:positive`);
    const r = await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(keys.map(k => ['GET', k]))
    });
    const results = await r.json();
    return new Set(
      cardIds.filter((_, i) => parseInt(results[i]?.result || '0', 10) > 0)
    );
  } catch { return new Set(); }
}

// ── re-ranking ────────────────────────────────────────────────────────────────
// Uses Sonnet for complex multi-constraint / counter queries (better reasoning),
// Haiku for simpler named_pokemon / synergy / budget queries (faster + cheaper).

async function rerank(originalQuery, intent, cards) {
  if (!cards.length) return cards;

  const usesSonnet = ['multi_constraint', 'counter'].includes(intent.type);
  const model = usesSonnet ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';

  const cardSummaries = cards.map(c => ({
    id: c.id, name: c.name, supertype: c.supertype, subtypes: c.subtypes, types: c.types,
    abilities: (c.abilities || []).map(a => `[${a.type}] ${a.name}: ${a.text}`),
    attacks: (c.attacks || []).map(a =>
      `${a.name} (cost:${a.convertedEnergyCost ?? a.cost?.length ?? '?'}, dmg:${a.damage || '0'}): ${a.text || ''}`
    ),
    rules: c.rules || [],
    retreatCost: c.retreatCost?.length ?? 0,
  }));

  // Build explicit pass/fail rules from structured criteria so reranker enforces them exactly
  const c = intent.criteria || {};
  const hardRules = [
    intent.constraints?.length && `ALL of these must be true simultaneously: ${intent.constraints.join('; ')}`,
    c.requireColorlessAttacksOnly && `HARD RULE: ALL of the card's attacks must use ONLY Colorless energy. Reject any card where even one attack requires typed energy (Fire, Water, etc.).`,
    c.cardTextContains          && `HARD RULE: Card's ability or attack text must contain "${c.cardTextContains}". Reject any card whose text does not mention this.`,
    c.requireAbility            && `HARD RULE: Card must have at least one Ability. Reject Pokémon with no abilities.`,
    c.excludePokemonRule        && `HARD RULE: Card must NOT have a rule box (no ex, V, VMAX, VSTAR). Single-prize only.`,
    c.requirePokemonRule        && `HARD RULE: Card MUST have a rule box (ex, V, VMAX, or VSTAR).`,
    c.requireStage              && `HARD RULE: Card must be a ${c.requireStage}. Reject other stages.`,
    c.minDamage                 && `HARD RULE: Card must have at least one attack dealing ${c.minDamage}+ damage.`,
    c.maxEnergyCost !== null && c.maxEnergyCost !== undefined && `HARD RULE: The qualifying attack must cost ${c.maxEnergyCost} energy or fewer.`,
  ].filter(Boolean).join('\n');

  const prompt = `You are a competitive Pokémon TCG expert. A player searched: "${originalQuery}"
Intent: ${intent.type}${intent.named_card ? ` (target: ${intent.named_card})` : ''}${intent.archetype_name ? ` (archetype: ${intent.archetype_name})` : ''}
${hardRules ? `\nSTRICT REQUIREMENTS — violating any one of these is grounds for rejection:\n${hardRules}\n` : ''}
Return ONLY the IDs of cards that genuinely fulfill ALL requirements, best matches first. Be strict — it is better to return fewer correct cards than many incorrect ones.
Return ONLY a JSON array of IDs, no markdown: ["id1","id2",...]

Candidates:
${JSON.stringify(cardSummaries, null, 1)}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await r.json();
    const text = data.content?.map(b => b.text || '').join('') || '';
    const ids = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!Array.isArray(ids)) return cards;
    const cardMap = new Map(cards.map(c => [c.id, c]));
    const ranked = ids.map(id => cardMap.get(id)).filter(Boolean);
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
  const cacheKey = `v8:search:standard:${typeFilter.toLowerCase()}:${query.trim().toLowerCase()}`;

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.status(200);

  const write = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch {} };

  try {
    // ── cache hit ──
    const cached = await cacheGet(cacheKey);
    if (cached) {
      const filtered = await filterFlagged(query, cached);
      const pinned   = await getPinned(query);
      const pinnedFiltered = await filterFlagged(query, pinned);
      const existingIds = new Set(filtered.map(m => m.id));
      for (const c of pinnedFiltered) {
        if (!existingIds.has(c.id)) filtered.push({ id: c.id, name: c.name, relevance: 'high', card: normalizeCard(c) });
      }
      // Boost positive-feedback cards to front
      const posIds = await getPositiveIds(query, filtered.map(m => m.id));
      if (posIds.size) {
        filtered.sort((a, b) => (posIds.has(b.id) ? 1 : 0) - (posIds.has(a.id) ? 1 : 0));
      }
      for (const match of filtered) write(match);
      write({ _done: true, _count: filtered.length, _cache: 'HIT' });
      return res.end();
    }

    // ── classify query ──
    const lqPre = query.toLowerCase();
    const likelyNeedsArchetypes = /\b(deck|list|build|counter|beat|against)\b/.test(lqPre);
    const [archetypes] = await Promise.all([
      likelyNeedsArchetypes ? getArchetypes().catch(() => []) : Promise.resolve([])
    ]);
    const intent = await classifyQuery(query, archetypes);

    // ── build search queries ──
    let primaryQuery = intent.rewritten_query || query;
    if (intent.type === 'named_pokemon' && intent.named_card) {
      primaryQuery = await buildNamedPokemonQuery(intent, query);
    } else if ((intent.type === 'archetype' || intent.type === 'counter') && intent._archetype) {
      primaryQuery = buildArchetypeQuery(intent);
    }

    // If a specific card text mechanic was identified, add it as an extra search angle
    const mechanic = intent.criteria?.cardTextContains;
    const mechanicQuery = mechanic ? `pokemon card with ability or attack that says "${mechanic}" ${primaryQuery}` : null;

    // Build query list: primary + mechanic variant + up to 2 alternatives from intent
    const altQueries = (intent.alternative_queries || []).slice(0, 2);
    const allQueries = [primaryQuery, mechanicQuery, ...altQueries].filter(Boolean);

    // ── parallel vector searches (RRF merge) ──
    const resultSets = await Promise.all(
      allQueries.map(q => vectorSearch(q, typeFilter, 100))
    );
    const vectorCards = mergeRRF(resultSets);

    // ── stat store augmentation for numeric constraint queries ──
    // Guarantees cards that qualify by exact stats are never missed due to semantic ranking
    let cards = vectorCards;
    const hasNumericConstraints = intent.type === 'multi_constraint' &&
      (intent.criteria?.minDamage || intent.criteria?.maxEnergyCost);

    if (hasNumericConstraints) {
      const statStore = await getStatStore();
      if (statStore) {
        const statMatches = statStoreFilter(statStore, intent.criteria);
        const vectorIds = new Set(vectorCards.map(c => c.id));
        // Convert stat store entries to the same shape as vector results
        const newFromStats = statMatches
          .filter(s => !vectorIds.has(s.id))
          .map(s => ({
            id: s.id, name: s.name, supertype: s.supertype, subtypes: s.subtypes,
            types: s.types, abilities: s.abilities, attacks: s.attacks, rules: s.rules,
            setName: s.setName, rarity: '', regulationMark: s.regulationMark,
            imageSmall: s.imageSmall, imageLarge: s.imageLarge, number: s.number,
            hp: String(s.hp), weaknesses: s.weaknesses, retreatCost: s.retreatCost,
            legalities: s.legalities,
          }));
        cards = [...vectorCards, ...newFromStats];
      }
    }

    if (!cards.length) {
      write({ _done: true, _count: 0 });
      return res.end();
    }

    // ── dedupe ──
    const seen = new Set();
    const deduped = cards.filter(c => {
      const norm = s => (s || '').toLowerCase().replace('é', 'e');
      const isPokemon = !['trainer', 'energy'].includes(norm(c.supertype));
      const key = isPokemon ? `${c.name}|${c.setName}` : c.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // ── hard structured filters ──
    const hardFiltered = (() => {
      const f1 = applyStructuredFilters(deduped, intent.criteria);
      if (f1.length > 0) return f1;
      const f2 = applyStructuredFilters(deduped, { ...intent.criteria, minDamage: null, maxEnergyCost: null, maxRetreatCost: null });
      if (f2.length > 0) return f2;
      return deduped;
    })();

    // ── feedback filtering + positive boost ──
    const preFiltered = await filterFlagged(query, hardFiltered);
    const safePreFiltered = preFiltered.length > 0 ? preFiltered : hardFiltered;

    const posIds = await getPositiveIds(query, safePreFiltered.map(c => c.id));
    const boosted = posIds.size
      ? [...safePreFiltered.filter(c => posIds.has(c.id)), ...safePreFiltered.filter(c => !posIds.has(c.id))]
      : safePreFiltered;

    // ── stream initial results immediately ──
    const initialResults = boosted.map(c => ({ id: c.id, name: c.name, relevance: 'high', card: normalizeCard(c) }));
    for (const match of initialResults) write(match);

    // ── semantic re-ranking (runs after initial results streamed) ──
    // Rerank whenever there are structural constraints or the query is complex
    const hasStructuralConstraints = !!(
      intent.criteria?.requireColorlessAttacksOnly ||
      intent.criteria?.cardTextContains ||
      intent.criteria?.requireAbility ||
      intent.criteria?.excludePokemonRule ||
      intent.criteria?.requirePokemonRule ||
      intent.criteria?.requireStage
    );
    const needsRerank = hasStructuralConstraints ||
      ['named_pokemon', 'multi_constraint', 'counter', 'synergy', 'budget'].includes(intent.type);
    let finalResults = initialResults;

    if (needsRerank && hardFiltered.length > 0) {
      const reranked = await rerank(query, intent, hardFiltered);
      const filteredReranked = await filterFlagged(query, reranked);
      const safeReranked = filteredReranked.length > 0 ? filteredReranked : reranked;

      // Apply positive boost to re-ranked set too
      const rerankedBoosted = posIds.size
        ? [...safeReranked.filter(c => posIds.has(c.id)), ...safeReranked.filter(c => !posIds.has(c.id))]
        : safeReranked;

      // Stream any new cards the re-ranker surfaced
      const streamedIds = new Set(initialResults.map(m => m.id));
      for (const c of rerankedBoosted) {
        if (!streamedIds.has(c.id)) write({ id: c.id, name: c.name, relevance: 'high', card: normalizeCard(c) });
      }

      write({ _reorder: rerankedBoosted.map(c => c.id) });
      finalResults = rerankedBoosted.map(c => ({ id: c.id, name: c.name, relevance: 'high', card: normalizeCard(c) }));
    }

    // ── pinned cards ──
    const pinned = await getPinned(query);
    const pinnedFiltered = await filterFlagged(query, pinned);
    const allStreamedIds = new Set(finalResults.map(m => m.id));
    for (const c of pinnedFiltered) {
      if (!allStreamedIds.has(c.id)) {
        const match = { id: c.id, name: c.name, relevance: 'high', card: normalizeCard(c) };
        finalResults.push(match);
        write(match);
      }
    }

    if (finalResults.length > 0) cacheSet(cacheKey, finalResults);

    write({ _done: true, _count: finalResults.length });
    return res.end();

  } catch (err) {
    console.error(err);
    try { write({ _error: err.message || 'Server error' }); res.end(); } catch {}
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function normalizeCard(c) {
  if (!c) return null;
  return {
    id: c.id, name: c.name, supertype: c.supertype, subtypes: c.subtypes || [],
    types: c.types || [], abilities: c.abilities || [], attacks: c.attacks || [],
    rules: c.rules || [], hp: c.hp || '', number: c.number || '',
    weaknesses: c.weaknesses || [], retreatCost: c.retreatCost || [],
    legalities: c.legalities || {},
    set: { name: c.setName || c.set?.name || '' },
    images: { small: c.imageSmall || c.images?.small || '', large: c.imageLarge || c.images?.large || '' }
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
  return results.filter(c => STANDARD_MARKS.includes(c.regulationMark));
}

