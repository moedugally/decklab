const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const CACHE_KEY = 'limitless:archetypes:ptcg';
const CACHE_TTL = 60 * 60 * 24 * 7; // 7 days

async function fetchFromLimitless() {
  const r = await fetch('https://play.limitlesstcg.com/api/games/PTCG/decks', {
    headers: { 'User-Agent': 'decklab/1.0' }
  });
  if (!r.ok) throw new Error(`Limitless API error: ${r.status}`);
  const data = await r.json();
  // Shape: [{ identifier, name, cards: [{id, name, count}], icons, variants }]
  return Array.isArray(data) ? data : [];
}

export async function getArchetypes() {
  // Try cache first
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/get/${encodeURIComponent(CACHE_KEY)}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` }
      });
      const d = await r.json();
      if (d.result) return JSON.parse(d.result);
    } catch { /* fall through */ }
  }

  // Fetch fresh from Limitless
  const archetypes = await fetchFromLimitless();

  // Cache it
  if (KV_URL && KV_TOKEN && archetypes.length) {
    fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', CACHE_KEY, JSON.stringify(archetypes), 'EX', CACHE_TTL]])
    }).catch(() => {});
  }

  return archetypes;
}

// Find an archetype by name match (fuzzy)
export function findArchetype(archetypes, query) {
  const lq = query.toLowerCase();
  return archetypes.find(a =>
    lq.includes(a.name.toLowerCase()) ||
    lq.includes(a.identifier.toLowerCase()) ||
    (a.variants || []).some(v => lq.includes(v.name?.toLowerCase() || ''))
  ) || null;
}

// HTTP handler for manual cache refresh
export default async function handler(req, res) {
  try {
    const archetypes = await fetchFromLimitless();
    if (KV_URL && KV_TOKEN) {
      await fetch(`${KV_URL}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([['SET', CACHE_KEY, JSON.stringify(archetypes), 'EX', CACHE_TTL]])
      });
    }
    return res.status(200).json({ ok: true, count: archetypes.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
