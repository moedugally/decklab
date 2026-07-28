// Temporary endpoint: accepts pre-enriched vector records and upserts to Upstash.
// Delete this file once Pitch Black enrichment is complete.
// Usage: POST /api/enrich-set?secret=decklab-enrich-2026  { "records": [...] }

const SECRET      = 'decklab-enrich-2026';
const VECTOR_URL  = process.env.UPSTASH_VECTOR_REST_URL;
const VECTOR_TOKEN = process.env.UPSTASH_VECTOR_REST_TOKEN;

export default async function handler(req, res) {
  if (req.query.secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });

  if (req.query.ping) {
    return res.json({ ok: true, hasVectorUrl: !!VECTOR_URL, hasVectorToken: !!VECTOR_TOKEN });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const records = req.body?.records;
  if (!Array.isArray(records) || !records.length) {
    return res.status(400).json({ error: 'Body must be { records: [...] }' });
  }

  try {
    const r = await fetch(`${VECTOR_URL}/upsert-data`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${VECTOR_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(records),
    });
    const data = await r.json();
    return res.json({ ok: true, upserted: records.length, result: data });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
