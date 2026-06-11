// One-time (and re-runnable) endpoint to index all Standard legal cards into Upstash Vector.
// Trigger by hitting: POST /api/index-cards  with header  x-index-secret: <INDEX_SECRET>
// Set INDEX_SECRET as a Vercel env var to protect this endpoint.

const STANDARD_MARKS = ['H', 'I', 'J'];
const VECTOR_URL = process.env.UPSTASH_VECTOR_REST_URL;
const VECTOR_TOKEN = process.env.UPSTASH_VECTOR_REST_TOKEN;
const TCG_API = 'https://api.pokemontcg.io/v2/cards';
const PAGE_SIZE = 250;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.INDEX_SECRET;
  if (secret && req.headers['x-index-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!VECTOR_URL || !VECTOR_TOKEN) {
    return res.status(500).json({ error: 'Upstash Vector env vars not set' });
  }

  try {
    const cards = await fetchAllStandardCards();
    const batches = chunk(cards.map(cardToVector), 100);

    let upserted = 0;
    for (const batch of batches) {
      await upsertVectors(batch);
      upserted += batch.length;
    }

    return res.status(200).json({ indexed: upserted });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchAllStandardCards() {
  const all = [];
  for (const mark of STANDARD_MARKS) {
    let page = 1;
    while (true) {
      const url = `${TCG_API}?q=${encodeURIComponent(`regulationMark:${mark}`)}&pageSize=${PAGE_SIZE}&page=${page}`;
      const r = await fetch(url);
      if (!r.ok) break;
      const data = await r.json();
      const cards = data.data || [];
      all.push(...cards);
      if (cards.length < PAGE_SIZE) break;
      page++;
    }
  }
  return all;
}

function cardToVector(c) {
  const parts = [`${c.name} (${c.supertype}${c.subtypes?.length ? ', ' + c.subtypes.join(', ') : ''})`];
  if (c.abilities?.length) {
    parts.push('Abilities: ' + c.abilities.map(a => `[${a.type}] ${a.name}: ${a.text}`).join(' | '));
  }
  if (c.attacks?.length) {
    parts.push('Attacks: ' + c.attacks.map(a => `${a.name}${a.damage ? ' (' + a.damage + ')' : ''}: ${a.text || ''}`).join(' | '));
  }
  if (c.rules?.length) {
    parts.push('Rules: ' + c.rules.join(' | '));
  }

  return {
    id: c.id,
    data: parts.join('\n'),
    metadata: {
      id: c.id,
      name: c.name,
      supertype: c.supertype,
      subtypes: c.subtypes || [],
      types: c.types || [],
      abilities: c.abilities || [],
      attacks: c.attacks || [],
      rules: c.rules || [],
      setName: c.set?.name || '',
      regulationMark: c.regulationMark || '',
      imageSmall: c.images?.small || '',
      imageLarge: c.images?.large || '',
      number: c.number || '',
      hp: c.hp || '',
      weaknesses: c.weaknesses || [],
      retreatCost: c.retreatCost || [],
      legalities: c.legalities || {}
    }
  };
}

async function upsertVectors(batch) {
  const r = await fetch(`${VECTOR_URL}/upsert-data`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VECTOR_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(batch)
  });
  if (!r.ok) {
    const e = await r.text();
    throw new Error(`Upstash upsert failed: ${e}`);
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
