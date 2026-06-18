// Builds the numeric stat store in Redis from cards already indexed in Upstash Vector.
// POST /api/build-stats  (protected by x-build-secret header)
//
// Scrolls through the vector index in pages, extracts numeric stats from each card's
// metadata, and stores the full list in Redis. Much faster than re-fetching from the
// Pokémon TCG API — all data is already in Upstash Vector from enrichment.

const KV_URL      = process.env.KV_REST_API_URL;
const KV_TOKEN    = process.env.KV_REST_API_TOKEN;
const VECTOR_URL  = process.env.UPSTASH_VECTOR_REST_URL;
const VECTOR_TOKEN = process.env.UPSTASH_VECTOR_REST_TOKEN;
const STANDARD_MARKS = ['H', 'I', 'J'];
const STATS_KEY = 'statsindex';
const STATS_TTL = 60 * 60 * 24 * 30; // 30 days

function parseMaxDamage(atk) {
  const raw  = (atk.damage || '').trim();
  const base = parseInt(raw.replace(/[^0-9]/g, '')) || 0;
  if (raw.includes('×')) return base > 0 ? 9999 : 0; // uncapped multiplier
  if (!raw.includes('+') && raw !== '') return base;
  const text = (atk.text || '').toLowerCase();
  const bonuses = [...text.matchAll(/(?:this attack does|does) (\d+) more damage/g)].map(m => parseInt(m[1]));
  if (raw.includes('+') && bonuses.length) return base + Math.max(...bonuses);
  if (raw === '') {
    const stated = [...text.matchAll(/this attack does (\d+) damage/g)].map(m => parseInt(m[1]));
    if (stated.length) return Math.max(...stated);
  }
  return base;
}

function extractStats(meta) {
  let maxDamage = 0;
  let minEnergyForBestAtk = 99;

  for (const atk of (meta.attacks || [])) {
    const dmg  = parseMaxDamage(atk);
    const cost = atk.convertedEnergyCost !== null && atk.convertedEnergyCost !== undefined
      ? parseInt(atk.convertedEnergyCost, 10)
      : (Array.isArray(atk.cost) ? atk.cost.length : 0);

    if (dmg > maxDamage || (dmg === maxDamage && cost < minEnergyForBestAtk)) {
      maxDamage = dmg;
      minEnergyForBestAtk = cost;
    }
  }

  return {
    id:                  meta.id,
    name:                meta.name,
    supertype:           meta.supertype || '',
    subtypes:            meta.subtypes || [],
    types:               meta.types || [],
    setName:             meta.setName || '',
    number:              meta.number || '',
    imageSmall:          meta.imageSmall || '',
    imageLarge:          meta.imageLarge || '',
    regulationMark:      meta.regulationMark || '',
    hp:                  parseInt(meta.hp || '0', 10) || 0,
    retreatCount:        (meta.retreatCost || []).length,
    maxDamage,
    minEnergyForBestAtk: maxDamage > 0 ? minEnergyForBestAtk : 99,
    abilities:   meta.abilities || [],
    attacks:     meta.attacks || [],
    rules:       meta.rules || [],
    weaknesses:  meta.weaknesses || [],
    retreatCost: meta.retreatCost || [],
    legalities:  meta.legalities || {},
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-build-secret'];
  if (process.env.BUILD_SECRET && secret !== process.env.BUILD_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'Redis not configured' });
  if (!VECTOR_URL || !VECTOR_TOKEN) return res.status(500).json({ error: 'Vector not configured' });

  try {
    const allStats = [];
    let cursor = 0;
    const PAGE = 1000;

    // Scroll through all vectors and collect metadata
    do {
      const r = await fetch(`${VECTOR_URL}/range`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${VECTOR_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursor, limit: PAGE, includeMetadata: true, includeVectors: false })
      });
      if (!r.ok) {
        const text = await r.text();
        return res.status(500).json({ error: `Vector range failed: ${text}` });
      }
      const data = await r.json();
      const vectors = data.result?.vectors || [];

      for (const v of vectors) {
        const meta = v.metadata;
        if (!meta || !STANDARD_MARKS.includes(meta.regulationMark)) continue;
        allStats.push(extractStats(meta));
      }

      cursor = data.result?.nextCursor ?? 0;
    } while (cursor !== 0);

    // Store in Redis
    await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', STATS_KEY, JSON.stringify(allStats), 'EX', STATS_TTL]])
    });

    return res.status(200).json({ ok: true, count: allStats.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
