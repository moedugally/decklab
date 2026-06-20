const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

export default async function handler(req, res) {
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'No KV credentials' });

  const r = await fetch(`${KV_URL}/lrange/query_log/0/-1`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const data = await r.json();
  const entries = (data.result || []).map(e => {
    try { return JSON.parse(e); } catch { return { q: e }; }
  });

  // Count frequency
  const freq = {};
  for (const e of entries) {
    const q = (e.q || e.query || '').trim().toLowerCase();
    if (q) freq[q] = (freq[q] || 0) + 1;
  }
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);

  res.status(200).json({
    total_entries: entries.length,
    unique_queries: sorted.length,
    top_queries: sorted.slice(0, 200).map(([q, n]) => ({ query: q, count: n })),
  });
}
