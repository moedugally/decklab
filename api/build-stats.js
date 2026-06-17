// Builds the numeric stat store in Redis by fetching all Standard-legal cards
// directly from the Pokémon TCG API. Cheaper than scrolling Upstash Vector
// (no vector read quota consumed) and always includes the latest sets.
// POST /api/build-stats  (protected by x-build-secret header)

const KV_URL      = process.env.KV_REST_API_URL;
const KV_TOKEN    = process.env.KV_REST_API_TOKEN;
const STANDARD_MARKS = ['H', 'I', 'J'];
const STATS_KEY = 'statsindex';
const STATS_TTL = 60 * 60 * 24 * 30; // 30 days

function parseMaxDamage(atk) {
  const raw  = (atk.damage || '').trim();
  const base = parseInt(raw.replace(/[^0-9]/g, '')) || 0;
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

function extractStats(c) {
  let maxDamage = 0;
  let minEnergyForBestAtk = 99;

  for (const atk of (c.attacks || [])) {
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
    id:                  c.id,
    name:                c.name,
    supertype:           c.supertype || '',
    subtypes:            c.subtypes || [],
    types:               c.types || [],
    setName:             c.set?.name || '',
    number:              c.number || '',
    imageSmall:          c.images?.small || '',
    imageLarge:          c.images?.large || '',
    regulationMark:      c.regulationMark || '',
    hp:                  parseInt(c.hp || '0', 10) || 0,
    retreatCount:        (c.retreatCost || []).length,
    maxDamage,
    minEnergyForBestAtk: maxDamage > 0 ? minEnergyForBestAtk : 99,
    abilities:   c.abilities || [],
    attacks:     c.attacks || [],
    rules:       c.rules || [],
    weaknesses:  c.weaknesses || [],
    retreatCost: c.retreatCost || [],
    legalities:  c.legalities || {},
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
    const allStats = [];
    const markFilter = STANDARD_MARKS.map(m => `regulationMark:${m}`).join(' OR ');

    // Fetch all Standard cards from TCG API, paginated
    let page = 1;
    const pageSize = 250;
    while (true) {
      const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`(${markFilter})`)}&pageSize=${pageSize}&page=${page}&select=id,name,supertype,subtypes,types,hp,attacks,abilities,rules,weaknesses,retreatCost,set,number,images,regulationMark,legalities`;
      const r = await fetch(url);
      if (!r.ok) {
        const text = await r.text();
        return res.status(500).json({ error: `TCG API failed page ${page}: ${text}` });
      }
      const data = await r.json();
      const cards = (data.data || []).filter(c => STANDARD_MARKS.includes(c.regulationMark));

      for (const c of cards) {
        allStats.push(extractStats(c));
      }

      if (!data.data?.length || data.data.length < pageSize) break;
      page++;
    }

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
