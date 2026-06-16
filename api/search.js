import { getArchetypes, findArchetype } from './archetypes.js';

const STANDARD_MARKS = ['H', 'I', 'J'];

const TCG_SLANG = {
  // Control / Disruption — mechanic queries with exact card text are handled via cardTextContains
  // (item lock, ability lock, retreat lock, attack lock, gust, bench snipe removed — go through Claude classification)
  'mill':              'discard cards from opponent deck deck-out win condition milling',
  'hand disruption':   'reduce opponent hand size discard cards iono supporter hand reset',
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
const CACHE_TTL = 60 * 60 * 6; // 6 hours — candidates only, logic always re-runs
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
- "named_pokemon": wants cards to SUPPORT a specific Pokémon (e.g. "heal crustle", "energy for dragapult", "works with mega lucario ex")
- "archetype": wants cards for a deck archetype (e.g. "dragapult ex deck", "mega lucario ex list")
- "counter": wants to beat/counter something (e.g. "beat dragapult ex", "counter alakazam dudunsparce")
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
    "cardTextContains": "<string OR array of strings — card ability/attack/rule text must contain ANY of these phrases. Use an array when the mechanic can be described multiple ways. e.g. 'move damage counters' or ['each of your', 'all of your Pokémon'] for multi-heal effects>",
    "requireWeakness": "<energy type the card must be weak to, e.g. 'Grass', 'Fire', 'Water' — or null>",
    "requireResistance": "<energy type the card must resist, e.g. 'Psychic', 'Metal' — or null>",
    "requireSubtype": "<specific subtype: 'Item'|'Supporter'|'Stadium'|'Ancient'|'Future'|'Tool'|'ACE SPEC' — or null. Use this for trainer subtypes AND pokemon traits>",
    "minHP": <minimum HP number, or null>,
    "maxHP": <maximum HP number, or null>,
    "minAttacks": <minimum number of attacks the card must have, or null>,
    "maxAttacks": <maximum number of attacks the card can have, or null>
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
- "heal multiple pokemon" / "heal all pokemon" / "heal your whole board" → cardTextContains: ["each of your", "all of your Pokémon", "each Pokémon"]
- "prevent damage to all pokemon" / "protect whole board" → cardTextContains: ["each of your", "all Pokémon"]
- "snipe whole bench" / "damage all benched" / "spread to every benched" / "spread damage" / "spread damage to bench" → cardTextContains: ["each of your opponent's Benched Pokémon", "to each Benched Pokémon", "also does 10 damage to all of your opponent's Benched", "to all of your opponent's Benched", "each of your opponent's Benched"]
- "inflict status" / "status condition" / "burn or poison" / "sleep or paralyze" → cardTextContains: ["is now Burned", "is now Poisoned", "is now Asleep", "is now Paralyzed", "is now Confused"]
- "force opponent to switch" / "switch their active" / "bring up opponent's benched" → cardTextContains: ["your opponent switches their Active", "your opponent's Active Pokémon to their Bench", "your opponent puts their Active"]
- "discard from opponent's hand" / "hand disruption" / "make opponent discard" / "discard opponent's hand" / "shuffle opponent's hand" → cardTextContains: ["discard a card from your opponent's hand", "your opponent discards a card", "your opponent discards 2", "shuffles their hand into their deck and draws", "your opponent discards cards from their hand until", "shuffles their hand and puts it on the bottom", "each player discards cards from their hand until", "Each player shuffles their hand into their deck"]
- "energy acceleration" / "accelerate energy" / "attach extra energy" (generic, no type specified) → do NOT set cardTextContains. Leave null, let reranker judge. Set rewritten_query to describe the mechanic clearly.
- "accelerate fire energy" / "fire energy acceleration" → do NOT set cardTextContains (a card like Blaziken that attaches "any Basic Energy" is a Fire accelerator but won't contain "Fire Energy"). requireTypes: null. Set rewritten_query: "cards that accelerate Fire energy — abilities or attacks that attach extra Basic Energy or specifically Fire Energy beyond the 1-per-turn rule, trainers that retrieve or search Fire Energy. Generic Basic Energy attachers like Blaziken qualify too."
- "accelerate water energy" / "water energy acceleration" → do NOT set cardTextContains. requireTypes: null. rewritten_query: "cards that accelerate Water energy — attach extra Water or Basic Energy beyond the 1-per-turn rule, retrieve/search Water Energy from discard or deck."
- "accelerate grass energy" / "grass energy acceleration" → do NOT set cardTextContains. requireTypes: null. rewritten_query: "cards that accelerate Grass energy beyond the 1-per-turn rule."
- "accelerate lightning energy" / "lightning energy acceleration" → do NOT set cardTextContains. requireTypes: null. rewritten_query: "cards that accelerate Lightning energy beyond the 1-per-turn rule."
- "accelerate psychic energy" / "psychic energy acceleration" → do NOT set cardTextContains. requireTypes: null. rewritten_query: "cards that accelerate Psychic energy beyond the 1-per-turn rule."
- "accelerate fighting energy" / "fighting energy acceleration" → do NOT set cardTextContains. requireTypes: null. rewritten_query: "cards that accelerate Fighting energy beyond the 1-per-turn rule."
- "accelerate darkness energy" / "dark energy acceleration" → do NOT set cardTextContains. requireTypes: null. rewritten_query: "cards that accelerate Darkness energy beyond the 1-per-turn rule."
- "accelerate metal energy" / "metal energy acceleration" → do NOT set cardTextContains. requireTypes: null. rewritten_query: "cards that accelerate Metal energy beyond the 1-per-turn rule."
- "prevent opponent from attacking" / "attack lock" / "can't attack" → cardTextContains: ["can't use any attacks", "can't attack during your opponent's next turn", "prevented from attacking", "the Defending Pokémon can't attack", "Pokémon that have 2 or less Energy attached can't attack", "can't use that attack"]
- "retreat lock" / "prevent opponent from retreating" / "trap active" → cardTextContains: ["opponent's Active Pokémon can't retreat", "Defending Pokémon can't retreat", "opponent's Pokémon can't retreat", "Poisoned Pokémon can't retreat", "can't retreat during your opponent's next turn", "that Pokémon can't retreat"] — NOTE: cards that say "this Pokémon can't retreat" (self-restriction) do NOT qualify
- "item lock" / "prevent opponent playing items" / "block items" → cardTextContains: ["can't play any Item cards from their hand", "your opponent can't play any Item cards"]
- "ability lock" / "shut off abilities" / "disable abilities" / "no abilities" → cardTextContains: ["have no Abilities", "has no Abilities"]  — NOTE: be careful, many stadium/tool cards say this; include all types
- "gust" / "boss effect" / "bring up benched" / "force active" / "bench to active" → cardTextContains: ["Switch in 1 of your opponent's Benched Pokémon to the Active Spot", "your opponent switches their Active Pokémon with 1 of their Benched", "put 1 of your opponent's Benched Pokémon into the Active Spot"]
- "bench snipe" / "damage benched pokemon" / "hit the bench" / "snipe" → cardTextContains: ["to 1 of your opponent's Benched Pokémon", "damage counter on 1 of your opponent's Benched", "on 1 of your opponent's Benched Pokémon"]
- "evolution lock" / "prevent evolution" / "stop opponent evolving" → cardTextContains: ["can't play any Pokémon from their hand to evolve their Pokémon", "can't play any Pokémon to evolve"]
- "extra prize" / "take more prizes" / "additional prize card" → cardTextContains: ["take 1 more Prize card", "take an additional Prize card", "take 2 more Prize cards", "take 3 more Prize cards", "take 1 Prize card from your opponent"]
- "discard opponent energy" / "energy removal" / "strip energy" → cardTextContains: ["Discard an Energy from your opponent's Active", "discard all Energy attached to your opponent's Active", "discard a Special Energy", "Pokémon Tools and Special Energy from your opponent's Active", "Pokémon Tools and Special Energy from all of your opponent's Pokémon"]
- "move energy between pokemon" / "energy transfer" / "move energy from one pokemon to another" → cardTextContains: ["Move a Basic Energy from 1 of your Pokémon to another", "move a Basic Energy from 1 of your Pokémon to another of your Pokémon", "Move an Energy from 1 of your Pokémon to another", "Move a Basic Grass Energy from 1 of your Pokémon to another", "Move an Energy from 1 of your opponent's Pokémon to another"]
- "pokemon that multiply damage" / "multiply existing damage" / "more damage per damage counter" / "damage based on damage counters" / "damage scales with damage counters" → cardTextContains: ["more damage for each damage counter on your opponent's Active", "for each damage counter on all", "damage for each damage counter on your opponent's Active", "damage for each damage counter on this Pokémon", "damage for each damage counter on the Defending", "10 more damage for each damage counter", "20 more damage for each damage counter", "30 more damage for each damage counter", "50 more damage for each damage counter", "70 more damage for each damage counter", "has any damage counters on it", "for each damage counter on that Pokémon", "damage counter you placed in this way"]
- "move damage counters" / "transfer damage counters" / "redirect damage counters" / "place damage counters from one to another" → cardTextContains: ["move any number of damage counters", "move all damage counters from", "move up to 3 damage counters", "move up to 2 damage counters", "move up to 1 damage counter", "move 3 damage counters", "move 2 damage counters", "move 1 damage counter", "move damage counters"]
- "get energy from discard pile" / "retrieve energy from discard" / "recover energy from discard" / "energy from discard" → cardTextContains: ["Basic Energy card from your discard pile", "Basic Energy cards from your discard pile", "Energy card from your discard pile", "Energy cards from your discard pile", "from your discard pile to 1 of your Benched", "from your discard pile to your Benched Pokémon in any way you like"]
- "get pokemon from discard pile" / "retrieve pokemon from discard" / "recover pokemon from discard" / "pokemon recovery" / "salvage pokemon from discard" → cardTextContains: ["from your discard pile onto your Bench", "Pokémon from your discard pile", "Pokémon or a Basic Energy card from your discard pile"]
- "get trainer from discard" / "get supporter from discard" / "get item from discard" / "retrieve trainer from discard" / "recover trainer from discard" / "trainer recovery" / "supporter recovery" → cardTextContains: ["Trainer card from your discard pile", "Supporter card from your discard pile", "Supporter cards from your discard pile", "Item card from your discard pile", "Item cards from your discard pile"]
- "gamble" / "coin flip" / "flip a coin" / "luck-based" / "chance cards" → cardTextContains: ["Flip a coin", "flip a coin until you get tails"]
- cardTextContains is ONLY appropriate when the mechanic has a single, exact, consistent phrase in card text (e.g. lock effects, gust, status conditions). Do NOT use cardTextContains for conceptual mechanics that can be expressed many different ways across card text — energy acceleration, healing, drawing, searching, damage movement. For those, leave cardTextContains null and write a precise rewritten_query so the vector search + reranker can judge.
- NEVER set requireSupertype when the query is about a mechanic that could appear on any card type — healing, drawing, searching, energy acceleration, damage placement, status effects, deck searching all appear on both Pokémon abilities/attacks AND trainer cards. Only set requireSupertype when the user explicitly says "pokemon", "trainer", "item", "supporter", "stadium", or "energy card". When in doubt, leave requireSupertype null.
- NEVER set requireTypes when the query is about accelerating, attaching, or searching for a specific energy type — e.g. "accelerate fire energy" should NOT set requireTypes: ["Fire"]. Cards that accelerate Fire energy include Stadiums, Supporters, and non-Fire Pokémon. requireTypes only applies when the user asks for Pokémon OF that type (e.g. "fire pokemon", "water type attacker").
- alternative_queries must be genuinely different angles

Examples:
- "heal crustle" → type: named_pokemon, excludeNames: ["Crustle"], rewritten_query: "trainer cards and abilities that remove damage counters or restore HP."
- "heal multiple pokemon at once" / "heal your whole board" / "heal all your pokemon" → requireSupertype: null (healing can come from Pokémon abilities AND trainer cards — do NOT restrict to trainer), cardTextContains: ["each of your Pokémon", "all of your Pokémon", "each Pokémon in play", "remove all damage", "heal all"]
- "heal one pokemon" / "restore HP" / "remove damage counters" → requireSupertype: null (same — do NOT assume trainer), cardTextContains: ["remove", "heal", "restore HP"]
- "low energy high damage attacker" → type: multi_constraint, minDamage: 130, maxEnergyCost: 2, rewritten_query: "pokemon with high damage output for minimal energy cost"
- "grass pokemon with only colorless attacks" → requireSupertype: "pokemon", requireTypes: ["Grass"], requireColorlessAttacksOnly: true, rewritten_query: "Grass type pokemon whose attacks only require Colorless energy, no typed energy cost, splashable attacker"
- "search deck for basic pokemon" / "find basic pokemon from deck" / "get basic from deck" → requireSupertype: null (Pokémon attacks like Call for Family and Abilities like Fan Rotom's also search the deck for Basics — do NOT restrict to trainer), cardTextContains: "search your deck"
- "accelerate fire energy" → cardTextContains: null, requireTypes: null, rewritten_query: "cards that accelerate Fire energy — abilities or attacks that attach extra Basic Energy or specifically Fire Energy beyond the 1-per-turn rule, trainers that search/retrieve Fire Energy. Generic Basic Energy attachers like Blaziken qualify."
- "accelerate water energy" → cardTextContains: null, requireTypes: null, rewritten_query: "cards that accelerate Water energy beyond the 1-per-turn rule"
- "move damage from my pokemon to opponents pokemon" → cardTextContains: "move damage counters", rewritten_query: "ability or attack that moves or transfers damage counters from your pokemon to opponent's pokemon. Damage counter manipulation, redirect damage."
- "1 prize attacker" → excludePokemonRule: true, requireSupertype: "pokemon", rewritten_query: "single prize non-ex non-V attacker"
- "pokemon with an ability" → requireAbility: true, requireSupertype: "pokemon"
- "dark pokemon with grass weakness" → requireTypes: ["Darkness"], requireSupertype: "pokemon", requireWeakness: "Grass"
- "fire weak pokemon" → requireWeakness: "Fire"
- "draw supporter" / "draw supporters" → requireSupertype: "trainer", requireSubtype: "Supporter"
- "healing item" / "item card" → requireSupertype: "trainer", requireSubtype: "Item"
- "stadium card" → requireSupertype: "trainer", requireSubtype: "Stadium"
- "ancient pokemon" → requireSupertype: "pokemon", requireSubtype: "Ancient"
- "future pokemon" → requireSupertype: "pokemon", requireSubtype: "Future"
- "psychic resistant" / "metal resist" → requireResistance: "Psychic" / "Metal"
- "high HP" / "tank" / "wall" → minHP: 200
- "200+ HP" → minHP: 200
- "pokemon with only 1 attack" → requireSupertype: "pokemon", maxAttacks: 1
- "ACE SPEC" → requireSubtype: "ACE SPEC"

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
        model: 'claude-sonnet-4-6',
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
    if (c.requireWeakness == null)     c.requireWeakness            = null;
    if (c.requireResistance == null)   c.requireResistance          = null;
    if (c.requireSubtype == null)      c.requireSubtype             = null;
    if (c.minHP == null)               c.minHP                      = null;
    if (c.maxHP == null)               c.maxHP                      = null;
    if (c.minAttacks == null)          c.minAttacks                 = null;
    if (c.maxAttacks == null)          c.maxAttacks                 = null;
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
    requireWeakness, requireResistance, requireSubtype,
    minHP, maxHP, minAttacks, maxAttacks,
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

    // Weakness / Resistance
    if (requireWeakness   && !(card.weaknesses   || []).some(w => w.type === requireWeakness))   return false;
    if (requireResistance && !(card.resistances  || []).some(r => r.type === requireResistance)) return false;

    // Subtype (Item / Supporter / Stadium / Ancient / Future / Tool / ACE SPEC / etc.)
    if (requireSubtype) {
      if (!(card.subtypes || []).some(s => norm(s) === norm(requireSubtype))) return false;
    }

    // HP range
    if (minHP !== null && minHP !== undefined) {
      if ((parseInt(card.hp || '0', 10) || 0) < minHP) return false;
    }
    if (maxHP !== null && maxHP !== undefined) {
      if ((parseInt(card.hp || '0', 10) || 0) > maxHP) return false;
    }

    // Attack count
    const atkCount = (card.attacks || []).length;
    if (minAttacks !== null && minAttacks !== undefined && atkCount < minAttacks) return false;
    if (maxAttacks !== null && maxAttacks !== undefined && atkCount > maxAttacks) return false;

    // Card text filter — phrase match against ability/attack/rules text.
    // Normalizes accents so "Pokémon" matches "pokemon" etc.
    if (cardTextContains) {
      const norm2   = s => (typeof s === 'string' ? s : '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const needles = (Array.isArray(cardTextContains) ? cardTextContains : [cardTextContains]).flat();
      const abilityText = (card.abilities || []).map(a => norm2(a.text)).join(' ');
      const attackText  = (card.attacks  || []).map(a => norm2(a.text)).join(' ');
      const rulesText   = (card.rules    || []).map(norm2).join(' ');
      const combined    = `${abilityText} ${attackText} ${rulesText}`;
      if (!needles.some(n => combined.includes(norm2(n)))) return false;
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
    c.cardTextContains          && `HARD RULE: Card's ability, attack, or rules text must contain ${Array.isArray(c.cardTextContains) ? 'at least one of: ' + [c.cardTextContains].flat().map(p => `"${p}"`).join(', ') : `"${c.cardTextContains}"`}. Read the actual text provided — do not assume a card qualifies based on its name. Reject any card whose text does not explicitly contain one of these phrases.`,
    c.requireAbility            && `HARD RULE: Card must have at least one Ability. Reject Pokémon with no abilities.`,
    c.excludePokemonRule        && `HARD RULE: Card must NOT have a rule box (no ex, V, VMAX, VSTAR). Single-prize only.`,
    c.requirePokemonRule        && `HARD RULE: Card MUST have a rule box (ex, V, VMAX, or VSTAR).`,
    c.requireStage              && `HARD RULE: Card must be a ${c.requireStage}. Reject other stages.`,
    c.requireWeakness           && `HARD RULE: Card must be weak to ${c.requireWeakness} type. Reject any card without ${c.requireWeakness} weakness.`,
    c.requireResistance         && `HARD RULE: Card must have ${c.requireResistance} resistance. Reject any card without it.`,
    c.requireSubtype            && `HARD RULE: Card must have subtype "${c.requireSubtype}" (e.g. Item/Supporter/Stadium/Ancient/Future). Reject others.`,
    c.minHP                     && `HARD RULE: Card must have ${c.minHP}+ HP. Reject lower HP cards.`,
    c.maxHP                     && `HARD RULE: Card must have ${c.maxHP} HP or less.`,
    c.minAttacks                && `HARD RULE: Card must have at least ${c.minAttacks} attacks.`,
    c.maxAttacks !== null && c.maxAttacks !== undefined && `HARD RULE: Card must have at most ${c.maxAttacks} attack(s).`,
    c.minDamage                 && `HARD RULE: Card must have at least one attack dealing ${c.minDamage}+ damage.`,
    c.maxEnergyCost !== null && c.maxEnergyCost !== undefined && `HARD RULE: The qualifying attack must cost ${c.maxEnergyCost} energy or fewer.`,
  ].filter(Boolean).join('\n');

  const prompt = `You are a competitive Pokémon TCG expert. A player searched: "${originalQuery}"
Intent: ${intent.type}${intent.named_card ? ` (target: ${intent.named_card})` : ''}${intent.archetype_name ? ` (archetype: ${intent.archetype_name})` : ''}
${hardRules ? `\nSTRICT REQUIREMENTS — violating any one of these is grounds for rejection:\n${hardRules}\n` : ''}
CRITICAL INSTRUCTIONS:
- Read each card's actual ability, attack, and rules text carefully before deciding.
- Base every decision ONLY on the text shown below. Do NOT rely on your prior knowledge of what a card does — card text is the sole source of truth.
- Card names can be misleading. A card only qualifies if its TEXT explicitly supports the query.
- For HARD RULEs: find the exact text that satisfies the rule. If you cannot find it in the card's text, the card is rejected.
- Be strict. Fewer correct results is always better than more incorrect ones.

Return ONLY the IDs of qualifying cards, best matches first.
Return ONLY a JSON array of IDs, no markdown: ["id1","id2",...]

Candidates:
${JSON.stringify(cardSummaries, null, 1)}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] })
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

// ── rarity deduplication ──────────────────────────────────────────────────────
// Within each name+set group, keep only the base rarity version so full arts,
// illustration rares, SIRs, and rainbow rares don't clog results.

const RARITY_RANK = {
  'common': 0, 'uncommon': 1,
  'rare': 2, 'rare holo': 3,
  'double rare': 4,                    // standard ex/V base rarity in SV era
  'rare holo ex': 4, 'rare holo lv.x': 4,
  'amazing rare': 5,
  'radiant rare': 6,
  'ace spec rare': 7,
  'illustration rare': 8,
  'ultra rare': 9,                     // full arts
  'special illustration rare': 10,
  'hyper rare': 11,                    // gold cards
  'shiny rare': 12, 'shiny ultra rare': 13,
  'trainer gallery rare holo': 14,
};

function rarityRank(rarity) {
  return RARITY_RANK[(rarity || '').toLowerCase()] ?? 3; // default: treat unknown as Rare Holo
}

function dedupeByBaseRarity(cards) {
  const normKey = s => (s || '').toLowerCase().replace('é', 'e');
  const groups  = new Map();

  for (const card of cards) {
    const isPokemon = !['trainer', 'energy'].includes(normKey(card.supertype));
    // Trainers dedup by name only (same card reprinted in different sets is the same card)
    // Pokémon dedup by name+set (same Pokémon in different sets may have different attacks)
    const key = isPokemon ? `${card.name}|${card.setName}` : card.name;

    if (!groups.has(key)) {
      groups.set(key, card);
    } else if (rarityRank(card.rarity) < rarityRank(groups.get(key).rarity)) {
      groups.set(key, card);
    }
  }

  const bySet = [...groups.values()];

  // Second pass: collapse cross-set reprints for Pokémon that share the same
  // name + identical attack fingerprint (all attack names + damage). Two cards
  // that attack identically are functionally the same for deck-building purposes.
  const reprints = new Map();
  for (const card of bySet) {
    const isPokemon = !['trainer', 'energy'].includes(normKey(card.supertype));
    if (!isPokemon) { reprints.set(`trainer|${card.name}`, card); continue; }
    const attackFingerprint = (card.attacks || [])
      .map(a => `${(a.name || '').toLowerCase()}:${a.damage || '0'}`)
      .join('|');
    const key = attackFingerprint ? `${normKey(card.name)}||${attackFingerprint}` : `${normKey(card.name)}|${card.setName}`;
    if (!reprints.has(key)) {
      reprints.set(key, card);
    } else if (rarityRank(card.rarity) < rarityRank(reprints.get(key).rarity)) {
      reprints.set(key, card);
    }
  }

  return [...reprints.values()];
}

// ── main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });

  const typeFilter = req.body.type || '';
  const cacheKey = `v33:search:standard:${typeFilter.toLowerCase()}:${query.trim().toLowerCase()}`;

  // Log query asynchronously — fire and forget, never blocks search
  if (KV_URL && KV_TOKEN) {
    const entry = JSON.stringify({ q: query.trim(), t: typeFilter || 'standard', ts: Date.now() });
    fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['LPUSH', 'query_log', entry],
        ['LTRIM', 'query_log', 0, 4999]  // keep last 5000
      ])
    }).catch(() => {});
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.status(200);

  const write = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch {} };

  try {
    // ── cache hit (candidates only — filtering/reranking always re-runs) ──
    const cachedCandidates = await cacheGet(cacheKey);

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

    // If a specific card text mechanic was identified, add multiple focused phrase queries
    // Use the raw phrases directly — the "pokemon card with..." prefix dilutes the embedding signal
    const mechanic = intent.criteria?.cardTextContains;
    const mechanicPhraseList = mechanic ? [mechanic].flat().slice(0, 4) : [];
    // Generate up to 2 mechanic queries: one from the most specific phrase, one combining the top 2
    const mechanicQuery  = mechanicPhraseList[0] || null;
    const mechanicQuery2 = mechanicPhraseList[1] || null;

    // Build query list: primary + mechanic phrases + up to 2 alternatives from intent
    const altQueries = (intent.alternative_queries || []).slice(0, 2);
    const allQueries = [primaryQuery, mechanicQuery, mechanicQuery2, ...altQueries].filter(Boolean);

    // ── parallel vector searches (RRF merge) — use cache if available ──
    let vectorCards;
    if (cachedCandidates) {
      vectorCards = cachedCandidates;
    } else {
      const resultSets = await Promise.all(
        allQueries.map((q, i) => vectorSearch(q, typeFilter, (i === 1 || i === 2) && (mechanicQuery || mechanicQuery2) ? 500 : 100))
      );
      // When type filter is active, add a broad sweep so enough type-filtered cards surface
      if (typeFilter) {
        const broadTypeQuery = `${typeFilter} type pokemon attacker`;
        resultSets.push(await vectorSearch(broadTypeQuery, typeFilter, 400));
      }
      vectorCards = mergeRRF(resultSets);
      cacheSet(cacheKey, vectorCards);
    }

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
      write({ _done: true, _count: 0, _debug: { intent: intent.type, criteria: intent.criteria, candidateCount: vectorCards.length, afterFilter: 0, fallbackFired: false } });
      return res.end();
    }

    // ── dedupe — keep base rarity within each name+set group ──
    const deduped = dedupeByBaseRarity(cards);

    // ── hard structured filters ──
    let fallbackFired = false;
    const hardFiltered = (() => {
      const f1 = applyStructuredFilters(deduped, intent.criteria);
      if (f1.length > 0) return f1;
      // Relax numeric constraints first
      const f2 = applyStructuredFilters(deduped, { ...intent.criteria, minDamage: null, maxEnergyCost: null, maxRetreatCost: null });
      if (f2.length > 0) return f2;
      // If cardTextContains phrases didn't match any card text, drop only the text
      // filter so other structural constraints still apply
      if (intent.criteria?.cardTextContains) {
        const f3 = applyStructuredFilters(deduped, { ...intent.criteria, cardTextContains: null, minDamage: null, maxEnergyCost: null, maxRetreatCost: null });
        if (f3.length > 0 && f3.length < deduped.length) return f3;
      }
      fallbackFired = true;
      return deduped;
    })();

    // ── feedback filtering + positive boost ──
    const preFiltered = await filterFlagged(query, hardFiltered);
    const safePreFiltered = preFiltered.length > 0 ? preFiltered : hardFiltered;

    const posIds = await getPositiveIds(query, safePreFiltered.map(c => c.id));

    // ── phrase-match boost: cards containing the exact cardTextContains phrases
    // are sorted to the front of the reranker input so they're guaranteed to be
    // evaluated even when the reranker cap truncates the candidate list.
    const ctcPhrases = intent.criteria?.cardTextContains
      ? (Array.isArray(intent.criteria.cardTextContains) ? intent.criteria.cardTextContains : [intent.criteria.cardTextContains]).flat()
      : [];
    const matchesPhrase = (card) => {
      if (!ctcPhrases.length) return false;
      const norm = s => (typeof s === 'string' ? s : '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const combined = [
        ...(card.abilities || []).map(a => norm(a.text)),
        ...(card.attacks   || []).map(a => norm(a.text)),
        ...(card.rules     || []).map(norm),
      ].join(' ');
      return ctcPhrases.some(p => combined.includes(norm(p)));
    };
    const phraseMatches    = safePreFiltered.filter(matchesPhrase);
    const phraseNonMatches = safePreFiltered.filter(c => !matchesPhrase(c));
    const phraseSorted = [...phraseMatches, ...phraseNonMatches];

    const boosted = posIds.size
      ? [...phraseSorted.filter(c => posIds.has(c.id)), ...phraseSorted.filter(c => !posIds.has(c.id))]
      : phraseSorted;

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
      intent.criteria?.requireStage ||
      intent.criteria?.requireSubtype ||
      intent.criteria?.requireWeakness ||
      intent.criteria?.requireResistance ||
      intent.criteria?.minHP ||
      intent.criteria?.maxAttacks !== null && intent.criteria?.maxAttacks !== undefined ||
      intent.criteria?.minAttacks
    );
    const needsRerank = hasStructuralConstraints ||
      ['named_pokemon', 'multi_constraint', 'counter', 'synergy', 'budget'].includes(intent.type);
    let finalResults = initialResults;

    if (needsRerank && hardFiltered.length > 0) {
      const usesSonnet = ['multi_constraint', 'counter'].includes(intent.type);
      const rerankCap = usesSonnet ? 40 : 120;
      // Use phraseSorted so exact-phrase matches are always in the top rerankCap slots
      const reranked = await rerank(query, intent, phraseSorted.slice(0, rerankCap));
      const filteredReranked = await filterFlagged(query, reranked);
      const safeReranked = filteredReranked.length > 0 ? filteredReranked : reranked;

      const rerankedBoosted = posIds.size
        ? [...safeReranked.filter(c => posIds.has(c.id)), ...safeReranked.filter(c => !posIds.has(c.id))]
        : safeReranked;

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

    write({ _done: true, _count: finalResults.length, _debug: { intent: intent.type, criteria: intent.criteria, candidateCount: vectorCards.length, afterFilter: hardFiltered.length, fallbackFired } });
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

