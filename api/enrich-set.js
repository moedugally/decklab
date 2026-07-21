// Temporary one-off endpoint for indexing a set's cards.
// Usage: POST /api/enrich-set?set=me5&page=0&pageSize=6&secret=decklab-enrich-2026
// Delete this file once enrichment is complete.

import Anthropic from '@anthropic-ai/sdk';
import { Index } from '@upstash/vector';

const SECRET   = 'decklab-enrich-2026';
const MODEL    = 'claude-sonnet-4-6';
const TCG_PAGE = 250;

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
4. DECK ARCHETYPES (current 2026 Standard meta only): Name every specific current meta deck this fits in. Current top archetypes include: Dragapult ex (variants: with Dusknoir, with Dudunsparce, with Mega Greninja ex [Greninja pult], with Blaziken ex [chicken pult / pult chicken], with Crushing Hammers [hammer pult]), Mega Lucario ex, Cynthia's Garchomp ex, Alakazam Dudunsparce, Festival Lead, Mega Lopunny Dudunsparce, Mega Frosslass Mega Starmie ex. Do NOT reference rotated archetypes.
5. SYNERGIES: Name specific currently-legal cards that combo with this card and explain the exact interaction.
6. COUNTERS: What current decks or strategies does this card beat or struggle against?
7. WHAT PROBLEM IT SOLVES: One sentence.
8. META STANDING: Staple / strong tech / niche / situational / unplayable. Be honest and current.
9. PLAYSTYLE TAGS: aggressive / control / combo / midrange / stall / turbo / spread / mill
10. UNIQUE MECHANICS: Describe any unusual interaction or ruling a competitive player would care about.
11. CARD STATS: Include HP, type(s), weakness, resistance, retreat cost in plain English.
12. CONCEPTUAL TAGS: Add plain-English phrases a player might search for.

Write in dense prose. Be specific and numeric.

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
  if (req.query.secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const setId    = req.query.set      || 'me5';
  const page     = parseInt(req.query.page     || '0', 10);
  const pageSize = parseInt(req.query.pageSize || '6',  10);

  // 1. Fetch all cards for this set
  const tcgUrl = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`set.id:${setId}`)}&pageSize=${TCG_PAGE}&page=1`;
  const tcgRes  = await fetch(tcgUrl, { headers: { 'User-Agent': 'decklab/1.0' } });
  const tcgData = await tcgRes.json();
  const allCards = tcgData.data || [];

  const total = allCards.length;
  const slice = allCards.slice(page * pageSize, (page + 1) * pageSize);
  if (!slice.length) return res.json({ done: true, total, page, processed: 0 });

  // 2. Enrich with Claude
  const summaries = slice.map(c => ({ id: c.id, text: cardText(c) }));
  const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let descriptions = {};
  try {
    const msg  = await anthropic.messages.create({
      model: MODEL, max_tokens: 8192,
      messages: [{ role: 'user', content: ENRICH_PROMPT + JSON.stringify(summaries, null, 1) }]
    });
    const text = msg.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    descriptions = Object.fromEntries(JSON.parse(text).map(x => [x.id, x.enriched]));
  } catch (e) {
    console.error('Claude enrichment failed:', e.message);
  }

  // 3. Upsert to vector index
  const index   = new Index({
    url:   process.env.UPSTASH_VECTOR_REST_URL,
    token: process.env.UPSTASH_VECTOR_REST_TOKEN,
  });
  const records = slice.map(c => cardToVector(c, descriptions[c.id] || ''));
  await index.upsert(records);

  return res.json({
    done:      (page + 1) * pageSize >= total,
    total,
    page,
    processed: slice.length,
    enriched:  Object.keys(descriptions).length,
    ids:       slice.map(c => c.id),
  });
}
