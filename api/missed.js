const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const STANDARD_MARKS = ['H', 'I', 'J'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query, cardName } = req.body;
  if (!query || !cardName) return res.status(400).json({ error: 'Invalid payload' });

  if (!KV_URL || !KV_TOKEN) return res.status(200).json({ ok: true });

  try {
    // Look up the card in the Pokemon TCG API
    const markFilter = STANDARD_MARKS.map(m => `regulationMark:${m}`).join(' OR ');
    const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`name:"${cardName}" (${markFilter})`)}&pageSize=5&orderBy=-set.releaseDate`;
    const r = await fetch(url);
    const data = await r.json();
    const card = (data.data || [])[0];

    // Record the submission regardless of whether we found the card
    const missedKey = `missed:${query.trim().toLowerCase()}:${cardName.trim().toLowerCase()}`;
    const pipeline = [['INCR', missedKey]];

    if (card && STANDARD_MARKS.includes(card.regulationMark)) {
      // Pin this card to the query so it appears in future searches
      const normalized = {
        id: card.id,
        name: card.name,
        supertype: card.supertype,
        subtypes: card.subtypes || [],
        types: card.types || [],
        abilities: card.abilities || [],
        attacks: card.attacks || [],
        rules: card.rules || [],
        hp: card.hp || '',
        number: card.number || '',
        weaknesses: card.weaknesses || [],
        retreatCost: card.retreatCost || [],
        legalities: card.legalities || {},
        setName: card.set?.name || '',
        rarity: card.rarity || '',
        regulationMark: card.regulationMark || '',
        imageSmall: card.images?.small || '',
        imageLarge: card.images?.large || '',
      };

      const pinnedKey = `pinned:${query.trim().toLowerCase()}`;
      // Fetch existing pins, append, dedupe, save
      const getRes = await fetch(`${KV_URL}/get/${encodeURIComponent(pinnedKey)}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` }
      });
      const getData = await getRes.json();
      const existing = getData.result ? JSON.parse(getData.result) : [];
      if (!existing.find(c => c.id === normalized.id)) {
        existing.push(normalized);
        pipeline.push(['SET', pinnedKey, JSON.stringify(existing)]);
      }
    }

    await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline)
    });

    return res.status(200).json({ ok: true, pinned: !!card });
  } catch {
    return res.status(200).json({ ok: true });
  }
}
