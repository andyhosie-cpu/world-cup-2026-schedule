// Capture newly-final World Cup results into the permanent ledger.
// Run by .github/workflows/capture-results.yml on a schedule (and manually).
//
// Fetches the live scores API and adds any match that is `completed` and not
// already in public/results.json. The workflow handles the commit/push.
//
// Design rules (Andy's spec):
//  - A result is captured once it is final, then stored permanently.
//  - A match already in the ledger is NEVER re-checked or overwritten — the
//    score won't change, so we keep trying only until we have the final, then
//    stop. (Dedup on joinKey does exactly this.)
//  - If the feed is unreachable or erroring, make no changes.
import { readFileSync, writeFileSync } from 'node:fs';

const SCORES_URL = 'https://world-cup-2026-schedule.vercel.app/api/scores';
const LEDGER = 'public/results.json';

let ledger;
try {
  ledger = JSON.parse(readFileSync(LEDGER, 'utf-8'));
} catch {
  ledger = { lastUpdated: null, completed: {} };
}
if (!ledger.completed) ledger.completed = {};

let feed;
try {
  const r = await fetch(SCORES_URL);
  feed = await r.json();
} catch (e) {
  console.log('feed unreachable, no changes:', e.message);
  process.exit(0);
}
if (feed.error || !feed.matches) {
  console.log('feed error, no changes:', feed.error || 'no matches');
  process.exit(0);
}

const now = new Date().toISOString();
const added = [];
for (const [key, m] of Object.entries(feed.matches)) {
  if (!m.completed) continue;          // not final yet — keep trying next run
  if (ledger.completed[key]) continue; // already stored — never re-check
  ledger.completed[key] = {
    homeTeam: m.homeTeam, awayTeam: m.awayTeam,
    homeScore: m.homeScore, awayScore: m.awayScore,
    commenceTime: m.commenceTime, recordedAt: now,
  };
  added.push(`${key}  ${m.homeTeam} ${m.homeScore}-${m.awayScore} ${m.awayTeam}`);
}

if (added.length === 0) {
  console.log('up to date, no new finals. ledger total:', Object.keys(ledger.completed).length);
  process.exit(0);
}

ledger.lastUpdated = now;
writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');
console.log(`Added ${added.length} new result(s):`);
for (const a of added) console.log('  ' + a);
