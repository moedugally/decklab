#!/usr/bin/env python3
"""
Decklab enriched indexing script.
Fetches all standard-legal cards (H/I/J), enriches each with a Claude-generated
strategic description, then upserts into Upstash Vector.

Usage:
  ANTHROPIC_API_KEY=... UPSTASH_VECTOR_REST_URL=... UPSTASH_VECTOR_REST_TOKEN=... python3 scripts/enrich-index.py

Optional flags:
  --force   Re-index all cards even if already in the index
"""

import json
import os
import sys
import time
import urllib.request
import urllib.parse
import urllib.error

# Load .env from project root if present
env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())

# ── config ───────────────────────────────────────────────────────────────────
STANDARD_MARKS = ['H', 'I', 'J']
BATCH_SIZE     = 3      # smaller batches = richer Sonnet output
UPSERT_BATCH   = 50
TCG_PAGE_SIZE  = 250
CLAUDE_MODEL   = 'claude-sonnet-4-6'

ANTHROPIC_KEY  = os.environ.get('ANTHROPIC_API_KEY', '')
VECTOR_URL     = os.environ.get('UPSTASH_VECTOR_REST_URL', '')
VECTOR_TOKEN   = os.environ.get('UPSTASH_VECTOR_REST_TOKEN', '')

# ── http helpers ──────────────────────────────────────────────────────────────
def http_post(url, body, headers):
    data = json.dumps(body).encode()
    req  = urllib.request.Request(url, data=data, headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())

def http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

# ── fetch cards ───────────────────────────────────────────────────────────────
def fetch_all_standard_cards():
    all_cards = []
    for mark in STANDARD_MARKS:
        page = 1
        while True:
            q   = f'regulationMark:{mark}'
            url = (f'https://api.pokemontcg.io/v2/cards'
                   f'?q={urllib.parse.quote(q)}&pageSize={TCG_PAGE_SIZE}&page={page}')
            try:
                data  = http_get(url, headers={'User-Agent': 'decklab/1.0'})
                cards = data.get('data', [])
                all_cards.extend(cards)
                print(f'  Mark {mark} page {page}: {len(cards)} cards')
                if len(cards) < TCG_PAGE_SIZE:
                    break
                page += 1
            except Exception as e:
                print(f'  Warning: fetch failed for mark={mark} page={page}: {e}')
                break
    return all_cards

# ── enrichment prompt ─────────────────────────────────────────────────────────
# Critical: descriptions must include exact numeric stats so the vector index
# can surface cards for queries like "low energy high damage attacker".
ENRICH_PROMPT = """You are a world-class competitive Pokémon TCG analyst writing semantic search descriptions. For each card, write a dense, specific strategic paragraph optimized for a vector search engine.

MANDATORY in every description:
1. EXACT NUMBERS: Every attack's exact damage and energy cost. Never omit or approximate.
2. PRIZE VALUE: Explicitly state "1-prize card" or "2-prize card" (ex/V/VMAX/VSTAR = 2-prize).
3. ROLE LABELS: Use all that apply: attacker / wall / pivot / support / tech / staple / searcher / accelerator / disruptor / finisher / stall / mill / snipe / spread / gust / lock / recovery
4. DECK ARCHETYPES: Name every specific meta deck this fits in (e.g. "Charizard ex", "Gardevoir ex", "Dragapult ex", "Lost Box", "Raging Bolt ex").
5. SYNERGIES: Name specific cards that combo with this card and explain why.
6. COUNTERS: What decks or strategies does this card beat or struggle against?
7. WHAT PROBLEM IT SOLVES: One sentence — "This card solves the problem of X for decks that need Y."
8. META STANDING: Staple / strong tech / niche / situational / unplayable. Be honest.
9. PLAYSTYLE TAGS: aggressive / control / combo / midrange / stall / turbo
10. UNIQUE MECHANICS: Describe any unusual interaction, ruling, or edge case a competitive player would care about.

Write in dense prose. Be specific and numeric. Do not be vague. A player searching "something that beats Charizard" or "1-prize wall with high HP" must find this card if it qualifies.

Return a JSON array, one object per card, same order as input:
[{"id": "...", "enriched": "...description..."}]

Cards:
"""

def card_text(c):
    parts = [f'{c["name"]} ({c.get("supertype","")}, {", ".join(c.get("subtypes") or [])})']
    if c.get('abilities'):
        parts.append('Abilities: ' + ' | '.join(
            f'[{a["type"]}] {a["name"]}: {a["text"]}' for a in c['abilities']))
    if c.get('attacks'):
        atk_parts = []
        for a in c['attacks']:
            cost_count = len(a.get('cost') or [])
            converted  = a.get('convertedEnergyCost', cost_count)
            atk_parts.append(
                f'{a["name"]} (cost:{converted} energy, dmg:{a.get("damage","0") or "0"}): {a.get("text","")}'
            )
        parts.append('Attacks: ' + ' | '.join(atk_parts))
    if c.get('rules'):
        parts.append('Rules: ' + ' | '.join(c['rules']))
    retreat = len(c.get('retreatCost') or [])
    parts.append(
        f'Set: {c.get("set",{}).get("name","")} | '
        f'HP: {c.get("hp","")} | '
        f'Types: {", ".join(c.get("types") or [])} | '
        f'Retreat cost: {retreat} | '
        f'Rarity: {c.get("rarity","")}'
    )
    return '\n'.join(parts)

def enrich_batch(cards):
    summaries = [{'id': c['id'], 'text': card_text(c)} for c in cards]
    prompt    = ENRICH_PROMPT + json.dumps(summaries, indent=1)

    for attempt in range(3):
        try:
            resp = http_post(
                'https://api.anthropic.com/v1/messages',
                {'model': CLAUDE_MODEL, 'max_tokens': 8192,
                 'messages': [{'role': 'user', 'content': prompt}]},
                {'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY,
                 'anthropic-version': '2023-06-01'}
            )
            text = ''.join(b.get('text', '') for b in resp.get('content', []))
            text = text.replace('```json', '').replace('```', '').strip()
            return {item['id']: item['enriched'] for item in json.loads(text)}
        except Exception as e:
            print(f'    Claude attempt {attempt+1} failed: {e}')
            time.sleep(2 ** attempt)
    return {}

# ── build vector record ───────────────────────────────────────────────────────
def card_to_vector(card, enriched_desc):
    raw_text  = card_text(card)
    full_text = f'{raw_text}\n\nSTRATEGIC CONTEXT:\n{enriched_desc}' if enriched_desc else raw_text

    # Pre-compute best-attack stats for fast numeric filtering in stat store
    max_damage = 0
    min_energy_for_best = 99
    for atk in (card.get('attacks') or []):
        try:
            dmg  = int(''.join(c for c in str(atk.get('damage','0') or '0') if c.isdigit()) or '0')
            cost_list = atk.get('cost') or []
            cost = atk.get('convertedEnergyCost', len(cost_list))
            if isinstance(cost, str):
                cost = int(cost)
            if dmg > max_damage or (dmg == max_damage and cost < min_energy_for_best):
                max_damage = dmg
                min_energy_for_best = cost
        except (ValueError, TypeError):
            pass

    return {
        'id':   card['id'],
        'data': full_text,
        'metadata': {
            'id':              card['id'],
            'name':            card['name'],
            'supertype':       card.get('supertype', ''),
            'subtypes':        card.get('subtypes') or [],
            'types':           card.get('types') or [],
            'abilities':       card.get('abilities') or [],
            'attacks':         card.get('attacks') or [],
            'rules':           card.get('rules') or [],
            'setName':         card.get('set', {}).get('name', ''),
            'rarity':          card.get('rarity', ''),
            'regulationMark':  card.get('regulationMark', ''),
            'imageSmall':      (card.get('images') or {}).get('small', ''),
            'imageLarge':      (card.get('images') or {}).get('large', ''),
            'number':          card.get('number', ''),
            'hp':              card.get('hp', ''),
            'weaknesses':      card.get('weaknesses') or [],
            'retreatCost':     card.get('retreatCost') or [],
            'legalities':      card.get('legalities') or {},
            # Pre-computed stat fields (used by stat store filter in search.js)
            'maxDamage':             max_damage,
            'minEnergyForBestAtk':   min_energy_for_best if max_damage > 0 else 99,
            'retreatCount':          len(card.get('retreatCost') or []),
        }
    }

# ── upsert to vector index ────────────────────────────────────────────────────
def upsert_vectors(records):
    for attempt in range(3):
        try:
            http_post(
                f'{VECTOR_URL}/upsert-data',
                records,
                {'Authorization': f'Bearer {VECTOR_TOKEN}', 'Content-Type': 'application/json'}
            )
            return
        except Exception as e:
            print(f'    Upsert attempt {attempt+1} failed: {e}')
            time.sleep(2 ** attempt)

def chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i+n]

# ── main ──────────────────────────────────────────────────────────────────────
def main():
    if not ANTHROPIC_KEY:
        print('ERROR: ANTHROPIC_API_KEY not set'); sys.exit(1)
    if not VECTOR_URL or not VECTOR_TOKEN:
        print('ERROR: UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN not set'); sys.exit(1)

    print('=== Decklab Enriched Indexer ===\n')
    print('Fetching standard-legal cards...')
    cards = fetch_all_standard_cards()
    print(f'\nTotal cards: {len(cards)}\n')

    total      = len(cards)
    processed  = 0
    vector_buf = []
    enriched   = 0

    for batch in chunks(cards, BATCH_SIZE):
        print(f'Enriching cards {processed+1}–{processed+len(batch)} / {total}...')
        descriptions = enrich_batch(batch)
        enriched += len(descriptions)

        for card in batch:
            desc   = descriptions.get(card['id'], '')
            record = card_to_vector(card, desc)
            vector_buf.append(record)

        processed += len(batch)

        if len(vector_buf) >= UPSERT_BATCH:
            print(f'  Upserting {len(vector_buf)} records...')
            for chunk in chunks(vector_buf, 100):
                upsert_vectors(chunk)
            vector_buf = []

        time.sleep(0.3)

    if vector_buf:
        print(f'  Upserting final {len(vector_buf)} records...')
        for chunk in chunks(vector_buf, 100):
            upsert_vectors(chunk)

    print(f'\n✓ Done. {total} cards indexed, {enriched} enriched with strategic descriptions.')
    print('\nNext step: run POST /api/build-stats to populate the numeric stat store in Redis.')

if __name__ == '__main__':
    main()
