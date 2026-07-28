// Temporary one-off endpoint for indexing a set's cards.
// Usage: GET /api/enrich-set?set=me5&page=0&pageSize=6&secret=decklab-enrich-2026
// Delete this file once enrichment is complete.

const SECRET   = 'decklab-enrich-2026';
const MODEL    = 'claude-sonnet-4-6';
const TCG_PAGE = 250;

const VECTOR_URL   = process.env.UPSTASH_VECTOR_REST_URL;
const VECTOR_TOKEN = process.env.UPSTASH_VECTOR_REST_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function cardText(c) {
  const parts = [`${c.name} (${c.supertype || ''}, ${(c.subtypes || []).join(', ')})`];
  if (c.abilities?.length) {
    parts.push('Abilities: ' + c.abilities.map(a => `[${a.type}] ${a.name}: ${a.text}`).join(' | '));
  }
  if (c.attacks?.length) {
    parts.push('Attacks: ' + c.attacks.map(a => {
      const cost = a.convertedEnergyCost ?? (a.cost || []).length;
      return `${a.name} (cost:${cost} energy, dmg:${a.damage || '0'}): ${a.text || ''}`;
    }).join(' | '));
  }
  if (c.rules?.length) parts.push('Rules: ' + c.rules.join(' | '));
  parts.push(
    `Set: ${c.set?.name || ''} | HP: ${c.hp || ''} | Types: ${(c.types || []).join(', ')} | ` +
    `Retreat cost: ${(c.retreatCost || []).length} | Rarity: ${c.rarity || ''}`
  );
  return parts.join('\n');
}

const ENRICH_PROMPT = `You are a world-class competitive Pokémon TCG analyst writing semantic search descriptions for the 2025-2026 Standard format (regulation marks H, I, J only). For each card, write a dense, specific strategic paragraph optimized for a vector search engine.

MANDATORY in every description:
1. EXACT NUMBERS: Every attack's exact damage and energy cost. Every ability's exact effect. Never omit or approximate.
2. PRIZE VALUE: Explicitly state "1-prize card" or "2-prize card" (ex/V/VMAX/VSTAR = 2-prize).
3. ROLE LABELS: Use all that apply: attacker / wall / pivot / support / tech / staple / searcher / accelerator / disruptor / finisher / stall / mill / snipe / spread / gust / lock / recovery / damage-placement / hand-disruption / energy-removal
4. DECK ARCHETYPES (current 2026 Standard meta only): Name every specific current meta deck this fits in. Current top archetypes include: Dragapult ex (variants: with Dusknoir, with Dudunsparce, with Mega Greninja ex [Greninja pult], with Blaziken ex [chicken pult / pult chicken], with Crushing Hammers [hammer pult]), Mega Lucario ex, Cynthia's Garchomp ex, Alakazam Dudunsparce, Festival Lead, Mega Lopunny Dudunsparce, Mega Frosslass Mega Starmie ex. Do NOT reference rotated archetypes (Charizard ex, Lost Box, Gardevoir ex, Raging Bolt ex, etc. — all rotated out of Standard).
5. SYNERGIES: Name specific currently-legal cards that combo with this card and explain the exact interaction.
6. COUNTERS: What current decks or strategies does this card beat or struggle against?
7. WHAT PROBLEM IT SOLVES: One sentence — "This card solves the problem of X for decks that need Y."
8. META STANDING: Staple / strong tech / niche / situational / unplayable. Be honest and current.
9. PLAYSTYLE TAGS: aggressive / control / combo / midrange / stall / turbo / spread / mill
10. UNIQUE MECHANICS: Describe any unusual interaction, ruling, or edge case a competitive player would care about. Include what the card does NOT do if that distinction matters (e.g. "moves damage counters, not Energy").
11. CARD STATS: Include HP, type(s), weakness, resistance, retreat cost written out in plain English.
12. CONCEPTUAL TAGS: Add plain-English phrases a player might search for. E.g. for a card that does bench damage: "bench damage", "spread damage", "hits benched pokemon". For hand disruption: "discard opponent hand", "hand disruption", "mill". For energy moving: "move energy", "energy transfer", "energy switch". These tags ensure the description is findable by natural language searches even when card text uses different phrasing.

Write in dense prose. Be specific and numeric. Do not be vague. A player searching "something that spreads damage to the bench" or "1-prize wall with high HP" or "hand disruption supporter" must find this card if it qualifies.

Return a JSON array, one object per card, same order as input:
[{"id": "...", "enriched": "...description..."}]

Cards:
`;

function cardToVector(card, enrichedDesc) {
  const raw  = cardText(card);
  const full = enrichedDesc ? `${raw}\n\nSTRATEGIC CONTEXT:\n${enrichedDesc}` : raw;

  let maxDamage = 0, minEnergy = 99;
  for (const atk of (card.attacks || [])) {
    const dmg  = parseInt(String(atk.damage || '0').replace(/\D/g, '') || '0', 10);
    const cost = typeof atk.convertedEnergyCost === 'number'
      ? atk.convertedEnergyCost : (atk.cost || []).length;
    if (dmg > maxDamage || (dmg === maxDamage && cost < minEnergy)) {
      maxDamage = dmg; minEnergy = cost;
    }
  }

  return {
    id:   card.id,
    data: full,
    metadata: {
      id:             card.id,
      name:           card.name,
      supertype:      card.supertype || '',
      subtypes:       card.subtypes  || [],
      types:          card.types     || [],
      abilities:      card.abilities || [],
      attacks:        card.attacks   || [],
      rules:          card.rules     || [],
      setName:        card.set?.name || '',
      rarity:         card.rarity    || '',
      regulationMark: card.regulationMark || '',
      imageSmall:     card.images?.small  || '',
      imageLarge:     card.images?.large  || '',
      number:         card.number    || '',
      hp:             card.hp        || '',
      weaknesses:     card.weaknesses  || [],
      retreatCost:    card.retreatCost || [],
      legalities:     card.legalities  || {},
      maxDamage,
      minEnergyForBestAtk: maxDamage > 0 ? minEnergy : 99,
      retreatCount: (card.retreatCost || []).length,
    }
  };
}

export default async function handler(req, res) {
  try { return await _handler(req, res); }
  catch (e) { return res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0,5) }); }
}

async function _handler(req, res) {
  if (req.query.secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });

  // Smoke test: just confirm env vars are present
  if (req.query.ping) {
    return res.json({
      ok: true,
      hasAnthropicKey: !!ANTHROPIC_KEY,
      hasVectorUrl: !!VECTOR_URL,
      hasVectorToken: !!VECTOR_TOKEN,
    });
  }

  const setId    = req.query.set      || 'me5';
  // page/pageSize refer to TCG API pagination — each call fetches one page directly
  const page     = parseInt(req.query.page     || '1', 10);
  const pageSize = parseInt(req.query.pageSize || '6',  10);

  // 1. Fetch one page of cards for this set directly from TCG API
  const tcgUrl = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`set.id:${setId}`)}&pageSize=${pageSize}&page=${page}&orderBy=number`;
  const tcgRes  = await fetch(tcgUrl, { headers: { 'User-Agent': 'decklab/1.0' } });
  const tcgData = await tcgRes.json();
  const slice   = tcgData.data || [];
  const total   = tcgData.totalCount || 0;

  if (!slice.length) return res.json({ done: true, total, page, processed: 0 });

  // 2. Enrich with Claude
  const summaries = slice.map(c => ({ id: c.id, text: cardText(c) }));
  let descriptions = {};
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8192,
        messages: [{ role: 'user', content: ENRICH_PROMPT + JSON.stringify(summaries, null, 1) }],
      }),
    });
    const msg  = await claudeRes.json();
    const text = (msg.content || []).map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    descriptions = Object.fromEntries(JSON.parse(text).map(x => [x.id, x.enriched]));
  } catch (e) {
    console.error('Claude enrichment failed:', e.message);
  }

  // 3. Upsert to vector index
  const records = slice.map(c => cardToVector(c, descriptions[c.id] || ''));
  const upsertRes = await fetch(`${VECTOR_URL}/upsert-data`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${VECTOR_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(records),
  });
  const upsertData = await upsertRes.json();

  return res.json({
    done:      slice.length < pageSize,
    total,
    page,
    processed: slice.length,
    enriched:  Object.keys(descriptions).length,
    upsert:    upsertData,
    ids:       slice.map(c => c.id),
  });
}
