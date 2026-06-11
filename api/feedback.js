const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const NEGATIVE_THRESHOLD = 3;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query, cardId, type } = req.body;
  if (!query || !cardId || !['positive', 'negative'].includes(type)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  if (!KV_URL || !KV_TOKEN) return res.status(200).json({ ok: true });

  const key = `feedback:${query.trim().toLowerCase()}:${cardId}:${type}`;

  try {
    await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['INCR', key]])
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(200).json({ ok: true }); // non-fatal
  }
}
