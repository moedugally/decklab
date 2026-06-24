// Resolves prices.pokemontcg.io/tcgplayer/{id} → real tcgplayer.com/product/{n} URL,
// wraps it in our affiliate link, and caches the result in Redis.
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const AFFILIATE_BASE = 'https://partner.tcgplayer.com/c/7426290/1780961/21018';

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const j = await r.json();
    return j.result ?? null;
  } catch { return null; }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value, ex: 60 * 60 * 24 * 30 }) // 30 days
    });
  } catch {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const { id } = req.query;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ error: 'invalid id' });

  const cacheKey = `tcglink:${id}`;
  const cached = await kvGet(cacheKey);
  if (cached) return res.status(200).json({ url: cached });

  // Resolve the redirect from the pokemontcg price proxy
  const proxyUrl = `https://prices.pokemontcg.io/tcgplayer/${id}`;
  let productUrl;
  try {
    const r = await fetch(proxyUrl, { redirect: 'manual' });
    const location = r.headers.get('location') || '';
    // location is like: https://tcgplayer.pxf.io/scrydex?u=https://tcgplayer.com/product/123
    const match = location.match(/[?&]u=(https?:\/\/(?:www\.)?tcgplayer\.com\/[^&\s]+)/);
    if (match) {
      productUrl = decodeURIComponent(match[1]);
    }
  } catch {}

  if (!productUrl) return res.status(404).json({ error: 'not found' });

  const affiliateUrl = `${AFFILIATE_BASE}?u=${encodeURIComponent(productUrl)}`;
  await kvSet(cacheKey, affiliateUrl);
  return res.status(200).json({ url: affiliateUrl });
}
