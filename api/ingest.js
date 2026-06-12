/**
 * Daily cron: ingest newly-completed World Cup results into the persistent
 * record at public/results.json. We commit straight back to the GitHub repo
 * via the API, which triggers an auto-deploy with the updated file.
 *
 * Required env vars:
 * - ODDS_API_KEY:  already set, used by oddsFetch
 * - GITHUB_TOKEN:  a fine-grained PAT with Contents: read+write on the repo
 * - CRON_SECRET:   optional; if set, must match the Vercel-provided header
 *
 * Schedule (vercel.json): once a day. The Odds API scores endpoint returns
 * the last 3 days of completed games, so daily ingestion always captures
 * everything.
 */
import { discoverSportKeys, oddsFetch, joinKey } from './_lib.js';

const REPO = 'andyhosie-cpu/world-cup-2026-schedule';
const RESULTS_PATH = 'public/results.json';

async function fetchResultsFile(token) {
  const r = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${RESULTS_PATH}`,
    { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'wc-ingest' } },
  );
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`GitHub GET ${r.status}: ${body.slice(0, 200)}`);
  }
  const json = await r.json();
  const content = Buffer.from(json.content, 'base64').toString('utf-8');
  return { json: JSON.parse(content), sha: json.sha };
}

async function commitResultsFile(token, updated, sha, addedCount) {
  const content = Buffer.from(JSON.stringify(updated, null, 2)).toString('base64');
  const r = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${RESULTS_PATH}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'wc-ingest',
      },
      body: JSON.stringify({
        message: `chore(results): ingest ${addedCount} new result${addedCount === 1 ? '' : 's'}`,
        content,
        sha,
      }),
    },
  );
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`GitHub PUT ${r.status}: ${body.slice(0, 200)}`);
  }
}

export default async function handler(req, res) {
  // Optional cron-secret auth: when CRON_SECRET is set Vercel includes it as
  // a Bearer token. Outside of cron the endpoint is still callable manually
  // for ad-hoc ingestion, but only if the right secret is provided.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'GITHUB_TOKEN not configured' });
    return;
  }

  try {
    const { matchKey } = await discoverSportKeys();
    if (!matchKey) {
      res.status(200).json({ ingested: 0, note: 'No sport key yet' });
      return;
    }

    const { data: games } = await oddsFetch(`/sports/${matchKey}/scores/`, {
      daysFrom: 3,
      dateFormat: 'iso',
    });

    const { json: current, sha } = await fetchResultsFile(token);
    const completed = { ...(current.completed || {}) };
    let added = 0;
    for (const game of games) {
      if (!game.completed) continue;
      const key = joinKey(game.commence_time, game.home_team, game.away_team);
      if (completed[key]) continue;
      const homeScoreRow = (game.scores || []).find((s) => s.name === game.home_team);
      const awayScoreRow = (game.scores || []).find((s) => s.name === game.away_team);
      completed[key] = {
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        homeScore: homeScoreRow ? homeScoreRow.score : null,
        awayScore: awayScoreRow ? awayScoreRow.score : null,
        commenceTime: game.commence_time,
        recordedAt: new Date().toISOString(),
      };
      added++;
    }

    if (added === 0) {
      res.status(200).json({ ingested: 0, note: 'Up to date', total: Object.keys(completed).length });
      return;
    }

    const updated = {
      lastUpdated: new Date().toISOString(),
      completed,
    };
    await commitResultsFile(token, updated, sha, added);
    res.status(200).json({ ingested: added, total: Object.keys(completed).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
