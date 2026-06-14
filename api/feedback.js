const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query, cardId, type } = req.body;
  if (!query || !cardId || !['positive', 'negative'].includes(type)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  if (!KV_URL || !KV_TOKEN) return res.status(200).json({ ok: true });

  const q          = query.trim().toLowerCase();
  const feedbackKey = `feedback:${q}:${cardId}:${type}`;
  const pipeline   = [['INCR', feedbackKey]];

  // Bust the search cache so the next query re-runs and respects the new feedback.
  // Covers all type-filter variants (no filter, and each energy type).
  const cacheTypes = ['', 'fire', 'water', 'grass', 'lightning', 'psychic',
                      'fighting', 'darkness', 'metal', 'dragon', 'colorless', 'fairy'];
  for (const t of cacheTypes) {
    pipeline.push(['DEL', `v11:search:standard:${t}:${q}`]);
  }

  try {
    await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline)
    });
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(200).json({ ok: true });
  }
}
