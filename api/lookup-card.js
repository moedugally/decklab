const STANDARD_MARKS = ['H', 'I', 'J'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cardName } = req.body;
  if (!cardName) return res.status(400).json({ error: 'Missing cardName' });

  try {
    const markFilter = STANDARD_MARKS.map(m => `regulationMark:${m}`).join(' OR ');
    const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`name:"${cardName}" (${markFilter})`)}&pageSize=20&orderBy=-set.releaseDate`;
    const r = await fetch(url);
    const data = await r.json();

    const cards = (data.data || [])
      .filter(c => STANDARD_MARKS.includes(c.regulationMark))
      .map(c => ({
        id: c.id,
        name: c.name,
        setName: c.set?.name || '',
        number: c.number || '',
        imageSmall: c.images?.small || '',
      }));

    return res.status(200).json({ cards });
  } catch {
    return res.status(200).json({ cards: [] });
  }
}
