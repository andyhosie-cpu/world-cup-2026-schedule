/**
 * GET /api/scores
 * Returns live + recently-completed + scheduled FIFA World Cup 2026 fixtures
 * indexed by join key (YYYY-MM-DD|teamA|teamB).
 *
 * Upstream: GET /v4/sports/{sportKey}/scores/?daysFrom=3
 * Quota cost: 2 credits per upstream call.
 * In-function cache: 90 seconds (warm-instance reuse).
 * Edge cache: s-maxage=60, stale-while-revalidate=120.
 */
import { discoverSportKeys, oddsFetch, withCache, joinKey, sendJson } from './_lib.js';

const CACHE_SECONDS = 90;

function statusOf(game) {
  if (game.completed) return 'FT';
  // Live if it has started and has scores but is not yet completed.
  const started = new Date(game.commence_time).getTime() <= Date.now();
  const hasScores = Array.isArray(game.scores) && game.scores.length > 0;
  if (started && hasScores) return 'LIVE';
  return 'SCHEDULED';
}

function pickScore(scoresArr, teamName) {
  if (!Array.isArray(scoresArr)) return null;
  const row = scoresArr.find((s) => s.name === teamName);
  return row ? row.score : null;
}

async function buildPayload() {
  const { matchKey } = await discoverSportKeys();
  if (!matchKey) {
    return {
      updated: new Date().toISOString(),
      matches: {},
      quotaRemaining: null,
      error: 'FIFA World Cup sport key not found upstream (tournament not listed yet?)',
    };
  }
  const { data, quotaRemaining } = await oddsFetch(
    `/sports/${matchKey}/scores/`,
    { daysFrom: 3, dateFormat: 'iso' },
  );

  const matches = {};
  for (const game of data) {
    const key = joinKey(game.commence_time, game.home_team, game.away_team);
    matches[key] = {
      homeTeam: game.home_team,
      awayTeam: game.away_team,
      homeScore: pickScore(game.scores, game.home_team),
      awayScore: pickScore(game.scores, game.away_team),
      completed: !!game.completed,
      commenceTime: game.commence_time,
      status: statusOf(game),
    };
  }
  return {
    updated: new Date().toISOString(),
    matches,
    quotaRemaining,
    error: null,
  };
}

export default async function handler(req, res) {
  try {
    const payload = await withCache('scores', CACHE_SECONDS, buildPayload);
    sendJson(res, 200, payload, 60, 120);
  } catch (err) {
    // Never throw to the client - degrade gracefully.
    sendJson(
      res,
      200,
      {
        updated: null,
        matches: {},
        quotaRemaining: err.quotaRemaining || null,
        error: err.message || 'Unknown error',
      },
      30,
      60,
    );
  }
}
