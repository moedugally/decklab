const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

export default async function handler(req, res) {
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'Redis not configured' });

  const queries = new Set();
  let cursor = 0;

  do {
    const r = await fetch(`${KV_URL}/scan/${cursor}?match=v*:search:standard:*&count=200`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    const data = await r.json();
    cursor = parseInt(data.result[0]);
    for (const key of (data.result[1] || [])) {
      // key format: v{N}:search:standard:{typeFilter}:{query}
      const parts = key.split(':');
      if (parts.length >= 5) {
        const query = parts.slice(4).join(':').trim();
        if (query) queries.add(query);
      }
    }
  } while (cursor !== 0);

  const sorted = [...queries].sort();
  res.setHeader('Content-Type', 'text/plain');
  res.status(200).send(sorted.join('\n'));
}
