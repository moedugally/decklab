#!/usr/bin/env python3
"""
Decklab enriched indexing script.
Fetches all standard-legal cards (H/I/J), enriches each with a Claude-generated
strategic description, then upserts into Upstash Vector.

Usage:
  ANTHROPIC_API_KEY=... UPSTASH_VECTOR_REST_URL=... UPSTASH_VECTOR_REST_TOKEN=... python3 scripts/enrich-index.py
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error

# Load .env file from project root if present
env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())

# ── config ──────────────────────────────────────────────────────────────────
STANDARD_MARKS   = ['H', 'I', 'J']
BATCH_SIZE       = 15      # cards per Claude call
UPSERT_BATCH     = 50      # cards per vector upsert
TCG_PAGE_SIZE    = 250
CLAUDE_MODEL     = 'claude-haiku-4-5-20251001'

ANTHROPIC_KEY    = os.environ.get('ANTHROPIC_API_KEY', '')
VECTOR_URL       = os.environ.get('UPSTASH_VECTOR_REST_URL', '')
VECTOR_TOKEN     = os.environ.get('UPSTASH_VECTOR_REST_TOKEN', '')

# ── helpers ──────────────────────────────────────────────────────────────────
def http_post(url, body, headers):
    data = json.dumps(body).encode()
    req  = urllib.request.Request(url, data=data, headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())

def http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

# ── fetch cards ──────────────────────────────────────────────────────────────
def fetch_all_standard_cards():
    all_cards = []
    for mark in STANDARD_MARKS:
        page = 1
        while True:
            q   = f'regulationMark:{mark}'
            url = f'https://api.pokemontcg.io/v2/cards?q={urllib.request.quote(q)}&pageSize={TCG_PAGE_SIZE}&page={page}'
            try:
                data  = http_get(url)
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

# ── enrich with Claude ───────────────────────────────────────────────────────
ENRICH_PROMPT = """You are a world-class competitive Pokémon TCG analyst. For each card below, generate a rich strategic description that will be used for semantic search. Be highly detailed and comprehensive.

Include ALL of the following:
- Exact mechanic description in plain language
- Every player slang / shorthand term that describes this card or its effect (e.g. "gust", "pivot", "wall", "mill", "nuke", "spread", "snipe", "accelerate", "reborn", "draw", "search", "boss", "switch")
- The archetype(s) this card belongs to or enables (e.g. spread damage deck, turbo energy deck, control, stall, aggro, lost zone box)
- Specific synergies: name the cards or card types that combo with this one
- What role it plays in a deck (attacker, support, energy acceleration, disruption, recovery, tech)
- What problem it solves for a deck builder
- Format context: is this a staple, tech, or niche card?
- Any unique or notable interactions

Return a JSON array, one object per card, in the same order as input:
[{"id": "...", "enriched": "...detailed description..."}]

Cards:
"""

def enrich_batch(cards):
    summaries = []
    for c in cards:
        parts = [f'{c["name"]} ({c.get("supertype","")}, {", ".join(c.get("subtypes") or [])})']
        if c.get('abilities'):
            parts.append('Abilities: ' + ' | '.join(
                f'[{a["type"]}] {a["name"]}: {a["text"]}' for a in c['abilities']))
        if c.get('attacks'):
            parts.append('Attacks: ' + ' | '.join(
                f'{a["name"]} ({a.get("damage","–")}): {a.get("text","")}' for a in c['attacks']))
        if c.get('rules'):
            parts.append('Rules: ' + ' | '.join(c['rules']))
        parts.append(f'Set: {c.get("set",{}).get("name","")} | HP: {c.get("hp","")} | Types: {", ".join(c.get("types") or [])} | Rarity: {c.get("rarity","")}')
        summaries.append({'id': c['id'], 'text': '\n'.join(parts)})

    prompt = ENRICH_PROMPT + json.dumps(summaries, indent=1)

    for attempt in range(3):
        try:
            resp = http_post(
                'https://api.anthropic.com/v1/messages',
                {
                    'model': CLAUDE_MODEL,
                    'max_tokens': 4096,
                    'messages': [{'role': 'user', 'content': prompt}]
                },
                {
                    'Content-Type': 'application/json',
                    'x-api-key': ANTHROPIC_KEY,
                    'anthropic-version': '2023-06-01'
                }
            )
            text = ''.join(b.get('text', '') for b in resp.get('content', []))
            text = text.replace('```json', '').replace('```', '').strip()
            return {item['id']: item['enriched'] for item in json.loads(text)}
        except Exception as e:
            print(f'    Claude attempt {attempt+1} failed: {e}')
            time.sleep(2 ** attempt)
    return {}

# ── build vector record ──────────────────────────────────────────────────────
def card_to_vector(card, enriched_desc):
    raw_parts = [f'{card["name"]} ({card.get("supertype","")}, {", ".join(card.get("subtypes") or [])})']
    if card.get('abilities'):
        raw_parts.append('Abilities: ' + ' | '.join(
            f'[{a["type"]}] {a["name"]}: {a["text"]}' for a in card['abilities']))
    if card.get('attacks'):
        raw_parts.append('Attacks: ' + ' | '.join(
            f'{a["name"]} ({a.get("damage","–")}): {a.get("text","")}' for a in card['attacks']))
    if card.get('rules'):
        raw_parts.append('Rules: ' + ' | '.join(card['rules']))

    raw_text = '\n'.join(raw_parts)
    full_text = f'{raw_text}\n\nSTRATEGIC CONTEXT:\n{enriched_desc}' if enriched_desc else raw_text

    return {
        'id': card['id'],
        'data': full_text,
        'metadata': {
            'id':             card['id'],
            'name':           card['name'],
            'supertype':      card.get('supertype', ''),
            'subtypes':       card.get('subtypes') or [],
            'types':          card.get('types') or [],
            'abilities':      card.get('abilities') or [],
            'attacks':        card.get('attacks') or [],
            'rules':          card.get('rules') or [],
            'setName':        card.get('set', {}).get('name', ''),
            'rarity':         card.get('rarity', ''),
            'regulationMark': card.get('regulationMark', ''),
            'imageSmall':     (card.get('images') or {}).get('small', ''),
            'imageLarge':     (card.get('images') or {}).get('large', ''),
            'number':         card.get('number', ''),
            'hp':             card.get('hp', ''),
            'weaknesses':     card.get('weaknesses') or [],
            'retreatCost':    card.get('retreatCost') or [],
            'legalities':     card.get('legalities') or {},
        }
    }

# ── upsert to vector index ───────────────────────────────────────────────────
def upsert_vectors(records):
    for attempt in range(3):
        try:
            http_post(
                f'{VECTOR_URL}/upsert-data',
                records,
                {
                    'Authorization': f'Bearer {VECTOR_TOKEN}',
                    'Content-Type': 'application/json'
                }
            )
            return
        except Exception as e:
            print(f'    Upsert attempt {attempt+1} failed: {e}')
            time.sleep(2 ** attempt)

def chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i+n]

# ── main ─────────────────────────────────────────────────────────────────────
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

    for batch in chunks(cards, BATCH_SIZE):
        print(f'Enriching cards {processed+1}–{processed+len(batch)} / {total}...')
        enrichments = enrich_batch(batch)

        for card in batch:
            desc   = enrichments.get(card['id'], '')
            record = card_to_vector(card, desc)
            vector_buf.append(record)

        processed += len(batch)

        # Upsert in bulk when buffer is large enough
        if len(vector_buf) >= UPSERT_BATCH:
            print(f'  Upserting {len(vector_buf)} records to vector index...')
            for chunk in chunks(vector_buf, 100):
                upsert_vectors(chunk)
            vector_buf = []

        time.sleep(0.3)  # be kind to APIs

    # Flush remaining
    if vector_buf:
        print(f'  Upserting final {len(vector_buf)} records...')
        for chunk in chunks(vector_buf, 100):
            upsert_vectors(chunk)

    print(f'\n✓ Done. {total} cards enriched and indexed.')

if __name__ == '__main__':
    main()
