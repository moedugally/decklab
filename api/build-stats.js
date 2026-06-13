// Builds the numeric stat store in Redis from the Pokemon TCG API.
// POST /api/build-stats  (protected by x-build-secret header)
//
// Run this once after initial deploy, and again whenever new sets release.
// The stat store lets search.js find cards by exact numeric stats (damage,
// energy cost) without relying on semantic vector ranking — ensuring cards
// like "Greninja ex (170dmg/2energy)" are never missed.

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const STANDARD_MARKS = ['H', 'I', 'J'];
const STATS_KEY = 'statsindex';
const STATS_TTL = 60 * 60 * 24 * 30; // 30 days

function extractStats(card) {
  let maxDamage = 0;
  let minEnergyForBestAtk = 99;

  for (const atk of (card.attacks || [])) {
    const dmg  = parseInt((atk.damage || '').replace(/[^0-9]/g, '')) || 0;
    const cost = atk.convertedEnergyCost !== null && atk.convertedEnergyCost !== undefined
      ? parseInt(atk.convertedEnergyCost, 10)
      : (Array.isArray(atk.cost) ? atk.cost.length : 0);

    if (dmg > maxDamage || (dmg === maxDamage && cost < minEnergyForBestAtk)) {
      maxDamage = dmg;
      minEnergyForBestAtk = cost;
    }
  }

  return {
    id:                  card.id,
    name:                card.name,
    supertype:           card.supertype || '',
    subtypes:            card.subtypes || [],
    types:               card.types || [],
    setName:             card.set?.name || '',
    number:              card.number || '',
    imageSmall:          card.images?.small || '',
    imageLarge:          card.images?.large || '',
    regulationMark:      card.regulationMark || '',
    hp:                  parseInt(card.hp || '0', 10) || 0,
    retreatCount:        (card.retreatCost || []).length,
    maxDamage,
    minEnergyForBestAtk: maxDamage > 0 ? minEnergyForBestAtk : 99,
    // Full card fields needed by normalizeCard in search.js
    abilities:   card.abilities || [],
    attacks:     card.attacks || [],
    rules:       card.rules || [],
    weaknesses:  card.weaknesses || [],
    retreatCost: card.retreatCost || [],
    legalities:  card.legalities || {},
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-build-secret'];
  if (process.env.BUILD_SECRET && secret !== process.env.BUILD_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'Redis not configured' });

  try {
    // Fetch all marks in parallel, paginating each concurrently
    async function fetchMark(mark) {
      const cards = [];
      let page = 1;
      while (true) {
        const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`regulationMark:${mark}`)}&pageSize=250&page=${page}`;
        const r = await fetch(url, { headers: { 'User-Agent': 'decklab/1.0' } });
        if (!r.ok) break;
        const data = await r.json();
        const batch = data.data || [];
        cards.push(...batch);
        if (batch.length < 250) break;
        page++;
      }
      return cards;
    }

    const results = await Promise.all(STANDARD_MARKS.map(fetchMark));
    const allCards = results.flat();

    const stats = allCards
      .filter(c => STANDARD_MARKS.includes(c.regulationMark))
      .map(extractStats);

    await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', STATS_KEY, JSON.stringify(stats), 'EX', STATS_TTL]])
    });

    return res.status(200).json({ ok: true, count: stats.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
