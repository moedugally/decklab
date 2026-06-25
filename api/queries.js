const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

export default async function handler(req, res) {
  if (!KV_URL || !KV_TOKEN) {
    return res.status(500).json({ error: 'KV not configured' });
  }

  try {
    const r = await fetch(`${KV_URL}/lrange/query_log/0/-1`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const j = await r.json();
    const entries = (j.result || []).map(e => JSON.parse(e));

    const total = entries.length;
    const byQuery = {};
    entries.forEach(({ q }) => {
      byQuery[q] = (byQuery[q] || 0) + 1;
    });
    const sorted = Object.entries(byQuery)
      .sort((a, b) => b[1] - a[1])
      .map(([query, count]) => ({ query, count }));

    const earliest = entries.length
      ? new Date(Math.min(...entries.map(e => e.ts))).toISOString()
      : null;
    const latest = entries.length
      ? new Date(Math.max(...entries.map(e => e.ts))).toISOString()
      : null;

    return res.status(200).json({ total, earliest, latest, queries: sorted });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
