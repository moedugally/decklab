#!/usr/bin/env node
/**
 * Decklab Search Regression Test
 *
 * Runs a list of known-good search queries against the search API
 * and verifies that previously-confirmed correct cards still appear
 * in the results. Catches regressions before they reach users.
 *
 * Usage:
 *   node regression-test.js --env=local
 *   node regression-test.js --env=live
 *   node regression-test.js --env=both
 */

const args = process.argv.slice(2);
const envArg = args.find(a => a.startsWith('--env='));
const env = envArg ? envArg.split('=')[1] : 'local';

const ENDPOINTS = {
  local: 'http://localhost:3000/api/search',
  live: 'https://decklab.gg/api/search',
};

// ============================================================
// KNOWN-GOOD TEST CASES
// Each query maps to cards that MUST appear in the results.
// Add to this list every time you confirm a search is correct.
// ============================================================
const TEST_CASES = [
  {
    query: 'item lock',
    mustInclude: ['Budew', 'Flaaffy', 'Frillish', 'Galvantula', 'Jellicent'],
  },
  {
    query: 'gust',
    mustInclude: ["Boss's Orders", "Team Rocket's Giovanni", 'Prime Catcher', 'Hariyama'],
  },
  {
    query: 'hand disruption',
    mustInclude: ['Special Red Card', 'Judge', 'Vivillon', "Xerosic's Machinations"],
  },
  {
    query: 'a way to move damage counters',
    mustInclude: ['Munkidori', 'Alakazam', 'Sableye', 'Ninetales'],
  },
  {
    query: 'a way to get basic pokemon from my deck',
    mustInclude: ['Buddy-Buddy Poffin', "Brock's Scouting", 'Fan Rotom', 'Purrloin'],
  },
  {
    query: 'fire energy acceleration',
    mustInclude: ['Firebreather', 'Blaziken', 'Emboar', "Ethan's Ho-Oh"],
  },
  {
    query: 'pokemon that do damage based on existing damage counters',
    mustInclude: ['Glalie', 'Galarian Obstagoon', 'Mega Feraligatr', "N's Reshiram"],
  },
];

// ============================================================
// TEST RUNNER
// ============================================================

async function runSearch(endpoint, query) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, format: 'standard', type: 'all' }),
    });
    if (!res.ok) {
      return { error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    // Adjust this based on your actual API response shape
    const cardNames = (data.cards || data.results || []).map(c => c.name || c.cardName || '');
    return { cardNames };
  } catch (e) {
    return { error: e.message };
  }
}

function checkInclusion(cardNames, mustInclude) {
  const missing = [];
  for (const expected of mustInclude) {
    const found = cardNames.some(name =>
      name.toLowerCase().includes(expected.toLowerCase())
    );
    if (!found) missing.push(expected);
  }
  return missing;
}

async function runTests(endpoint, envLabel) {
  console.log(`\n=== Testing against ${envLabel} (${endpoint}) ===\n`);
  let passCount = 0;
  let failCount = 0;
  const failures = [];

  for (const test of TEST_CASES) {
    const result = await runSearch(endpoint, test.query);

    if (result.error) {
      console.log(`❌ FAIL  "${test.query}"  →  ERROR: ${result.error}`);
      failCount++;
      failures.push({ query: test.query, reason: result.error });
      continue;
    }

    const missing = checkInclusion(result.cardNames, test.mustInclude);

    if (missing.length === 0) {
      console.log(`✅ PASS  "${test.query}"`);
      passCount++;
    } else {
      console.log(`❌ FAIL  "${test.query}"  →  missing: ${missing.join(', ')}`);
      console.log(`         got: ${result.cardNames.slice(0, 8).join(', ')}${result.cardNames.length > 8 ? '...' : ''}`);
      failCount++;
      failures.push({ query: test.query, missing });
    }
  }

  console.log(`\n--- ${envLabel} summary: ${passCount} passed, ${failCount} failed ---\n`);
  return { passCount, failCount, failures };
}

async function main() {
  const results = {};

  if (env === 'local' || env === 'both') {
    results.local = await runTests(ENDPOINTS.local, 'LOCAL');
  }
  if (env === 'live' || env === 'both') {
    results.live = await runTests(ENDPOINTS.live, 'LIVE');
  }

  const totalFailures = Object.values(results).reduce((sum, r) => sum + r.failCount, 0);

  if (totalFailures > 0) {
    console.log(`\n🚨 ${totalFailures} regression(s) detected. Do not ship until fixed.\n`);
    process.exit(1);
  } else {
    console.log(`\n✨ All regression tests passed.\n`);
    process.exit(0);
  }
}

main();
