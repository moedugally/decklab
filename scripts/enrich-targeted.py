#!/usr/bin/env python3
"""
Targeted re-enrichment for specific cards that are missing from vector search results
despite having phrase-matching text. Run this to force these cards into the candidate pool
for their primary mechanic searches.
"""

import json, os, time, urllib.request, urllib.parse

env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())

ANTHROPIC_KEY = os.environ['ANTHROPIC_API_KEY']
VECTOR_URL    = os.environ['UPSTASH_VECTOR_REST_URL']
VECTOR_TOKEN  = os.environ['UPSTASH_VECTOR_REST_TOKEN']
CLAUDE_MODEL  = 'claude-sonnet-4-6'

TARGET_IDS = ['sv7-8', 'sv9-124', 'me4-81']

def http_post(url, body, headers):
    data = json.dumps(body).encode()
    req  = urllib.request.Request(url, data=data, headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())

def http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def fetch_card(card_id):
    url = f'https://api.pokemontcg.io/v2/cards?q=id:{card_id}'
    data = http_get(url, headers={'User-Agent': 'decklab/1.0'})
    cards = data.get('data', [])
    return cards[0] if cards else None

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

ENRICH_PROMPT = """You are a world-class competitive Pokémon TCG analyst writing semantic search descriptions for the 2025-2026 Standard format (regulation marks H, I, J only). For each card, write a dense, specific strategic paragraph optimized for a vector search engine.

CRITICAL: The PRIMARY MECHANIC of each card must be the absolute focal point of the description — use the exact terminology a player would search for. These cards were missed in mechanic-based searches because their primary role was underemphasized. Fix that.

MANDATORY in every description:
1. EXACT NUMBERS: Every attack's exact damage and energy cost. Every ability's exact effect. Never omit or approximate.
2. PRIZE VALUE: Explicitly state "1-prize card" or "2-prize card".
3. PRIMARY MECHANIC FIRST: Lead with the card's defining mechanic using every natural-language phrase a player might search. E.g. for energy removal: "strips energy", "discards energy", "removes tools AND special energy from the opponent's active pokemon", "energy removal", "tool removal", "special energy removal", "discards pokémon tools and special energy". For supporter retrieval from discard: "retrieves a supporter from the discard pile", "gets a supporter back from discard", "supporter recovery", "recycles supporters", "puts supporter from discard into hand". For retreat lock: "locks the opponent's poisoned pokemon in place", "prevents poisoned pokemon from retreating", "retreat lock for poisoned pokemon", "traps active if poisoned".
4. ROLE LABELS: Use all that apply from: attacker / wall / pivot / support / tech / staple / searcher / accelerator / disruptor / finisher / stall / mill / snipe / spread / gust / lock / recovery / damage-placement / hand-disruption / energy-removal / tool-removal / retreat-lock / trainer-recovery
5. DECK ARCHETYPES (current 2026 Standard meta only): Dragapult ex (variants: with Dusknoir, with Mega Greninja ex [Greninja pult], with Blaziken ex [chicken pult]), Mega Lucario ex, Cynthia's Garchomp ex, Alakazam Dudunsparce, Festival Lead, Mega Lopunny Dudunsparce, Mega Frosslass Mega Starmie ex. Do NOT reference rotated sets.
6. SYNERGIES: Specific currently-legal cards that combo with this card.
7. WHAT PROBLEM IT SOLVES: One sentence.
8. META STANDING: Staple / strong tech / niche / situational / unplayable.
9. CARD STATS: HP, type, weakness, resistance, retreat cost.

Write in dense prose. Be specific. A player searching for the primary mechanic by any natural phrasing must find this card.

Return a JSON array:
[{"id": "...", "enriched": "...description..."}]

Cards:
"""

def enrich_cards(cards):
    summaries = [{'id': c['id'], 'text': card_text(c)} for c in cards]
    prompt = ENRICH_PROMPT + json.dumps(summaries, indent=1)
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
            print(f'  Claude attempt {attempt+1} failed: {e}')
            time.sleep(2 ** attempt)
    return {}

def upsert_card(card, enriched_desc):
    raw_text  = card_text(card)
    full_text = f'{raw_text}\n\nSTRATEGIC CONTEXT:\n{enriched_desc}' if enriched_desc else raw_text

    max_damage = 0
    min_energy = 99
    for atk in (card.get('attacks') or []):
        try:
            dmg  = int(''.join(c for c in str(atk.get('damage','0') or '0') if c.isdigit()) or '0')
            cost_list = atk.get('cost') or []
            cost = atk.get('convertedEnergyCost', len(cost_list))
            if isinstance(cost, str): cost = int(cost)
            if dmg > max_damage or (dmg == max_damage and cost < min_energy):
                max_damage = dmg
                min_energy = cost
        except: pass

    vector_record = {
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
            'hp':              card.get('hp', ''),
            'number':          card.get('number', ''),
            'weaknesses':      card.get('weaknesses') or [],
            'retreatCost':     card.get('retreatCost') or [],
            'legalities':      card.get('legalities') or {},
            'imageSmall':      (card.get('images') or {}).get('small', ''),
            'imageLarge':      (card.get('images') or {}).get('large', ''),
            'maxDamage':             max_damage,
            'minEnergyForBestAtk':   min_energy if max_damage > 0 else 99,
            'retreatCount':          len(card.get('retreatCost') or []),
        }
    }

    result = http_post(
        f'{VECTOR_URL}/upsert-data',
        [vector_record],
        {'Authorization': f'Bearer {VECTOR_TOKEN}', 'Content-Type': 'application/json'}
    )
    return result

if __name__ == '__main__':
    print('Fetching target cards...')
    cards = []
    for cid in TARGET_IDS:
        c = fetch_card(cid)
        if c:
            print(f'  Fetched: {c["id"]} {c["name"]}')
            cards.append(c)
        else:
            print(f'  WARNING: could not fetch {cid}')
        time.sleep(0.3)

    print(f'\nEnriching {len(cards)} cards with Claude...')
    enriched = enrich_cards(cards)
    print(f'  Got enrichment for {len(enriched)} cards')

    print('\nUpserting to vector index...')
    for card in cards:
        desc = enriched.get(card['id'], '')
        if desc:
            print(f'  Enriched text preview for {card["id"]} {card["name"]}:')
            print(f'    {desc[:200]}...')
        result = upsert_card(card, desc)
        print(f'  Upserted {card["id"]}: {result}')
        time.sleep(0.5)

    print('\nDone.')
