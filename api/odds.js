/**
 * GET /api/odds
 * Returns best-available decimal h2h prices per fixture, indexed by join key.
 * "Best" = highest decimal price across all UK bookmakers (best for the punter).
 *
 * Upstream: GET /v4/sports/{sportKey}/odds/?regions=uk&markets=h2h&oddsFormat=decimal
 * Quota cost: 1 credit per upstream call (1 region x 1 market).
 * In-function cache: 600 seconds (10 minutes).
 * Edge cache: s-maxage=300, stale-while-revalidate=600.
 *
 * To swap bookmaker region (eu, us, au), change the REGIONS constant below.
 */
import { discoverSportKeys, oddsFetch, withCache, joinKey, sendJson } from './_lib.js';

const REGIONS = 'uk';
const CACHE_SECONDS = 600;

function pickBestPrices(game) {
  let bestHome = null;
  let bestDraw = null;
  let bestAway = null;
  let bookmakerCount = 0;

  for (const bm of game.bookmakers || []) {
    const market = (bm.markets || []).find((m) => m.key === 'h2h');
    if (!market) continue;
    bookmakerCount++;
    for (const out of market.outcomes || []) {
      const price = Number(out.price);
      if (!Number.isFinite(price)) continue;
      const entry = { price, bookmaker: bm.title || bm.key };
      if (out.name === game.home_team) {
        if (!bestHome || price > bestHome.price) bestHome = entry;
      } else if (out.name === game.away_team) {
        if (!bestAway || price > bestAway.price) bestAway = entry;
      } else if (out.name === 'Draw') {
        if (!bestDraw || price > bestDraw.price) bestDraw = entry;
      }
    }
  }
  return { home: bestHome, draw: bestDraw, away: bestAway, bookmakerCount };
}

async function buildPayload() {
  const { matchKey } = await discoverSportKeys();
  if (!matchKey) {
    return {
      updated: new Date().toISOString(),
      matches: {},
      quotaRemaining: null,
      error: 'FIFA World Cup sport key not found upstream',
    };
  }
  const { data, quotaRemaining } = await oddsFetch(
    `/sports/${matchKey}/odds/`,
    {
      regions: REGIONS,
      markets: 'h2h',
      oddsFormat: 'decimal',
      dateFormat: 'iso',
    },
  );

  const matches = {};
  for (const game of data) {
    const best = pickBestPrices(game);
    if (!best.home && !best.draw && !best.away) continue;
    const key = joinKey(game.commence_time, game.home_team, game.away_team);
    matches[key] = {
      homeTeam: game.home_team,
      awayTeam: game.away_team,
      commenceTime: game.commence_time,
      best: { home: best.home, draw: best.draw, away: best.away },
      bookmakerCount: best.bookmakerCount,
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
    const payload = await withCache('odds', CACHE_SECONDS, buildPayload);
    sendJson(res, 200, payload, 300, 600);
  } catch (err) {
    sendJson(
      res,
      200,
      {
        updated: null,
        matches: {},
        quotaRemaining: err.quotaRemaining || null,
        error: err.message || 'Unknown error',
      },
      60,
      120,
    );
  }
}
