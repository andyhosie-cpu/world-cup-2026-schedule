/**
 * GET /api/outrights
 * Returns the tournament-winner outright market with the BEST decimal price
 * per team across all UK bookmakers (highest = best for the punter), sorted
 * ascending by best price so favourites lead the list.
 *
 * Upstream sport key: discovered dynamically (has_outrights=true companion to
 * the main FIFA World Cup fixture). If no outrights sport exists yet, returns
 * an empty list with an explanatory error.
 *
 * Quota cost: 1 credit per upstream call.
 * In-function cache: 1800 seconds (30 minutes).
 */
import { discoverSportKeys, oddsFetch, withCache, sendJson } from './_lib.js';

const REGIONS = 'uk';
const CACHE_SECONDS = 1800;

function aggregateBest(eventList) {
  // The outrights endpoint returns one or more "events" (usually one - the
  // tournament). Each event has bookmakers -> markets (outrights) -> outcomes.
  // For each team name, pick the HIGHEST decimal price across bookmakers -
  // that is the best return per stake for the punter. Sorting ascending by
  // that best price still puts the favourites first.
  const byTeam = {};
  for (const ev of eventList || []) {
    for (const bm of ev.bookmakers || []) {
      const market = (bm.markets || []).find(
        (m) => m.key === 'outrights' || m.key === 'outright_winner',
      );
      if (!market) continue;
      for (const out of market.outcomes || []) {
        const price = Number(out.price);
        if (!Number.isFinite(price)) continue;
        const team = out.name;
        const entry = { price, bookmaker: bm.title || bm.key };
        const prev = byTeam[team];
        if (!prev || price > prev.price) byTeam[team] = entry;
      }
    }
  }
  return Object.entries(byTeam)
    .map(([team, e]) => ({ team, bestPrice: e.price, bookmaker: e.bookmaker }))
    .sort((a, b) => a.bestPrice - b.bestPrice);
}

async function buildPayload() {
  const { outrightsKey } = await discoverSportKeys();
  if (!outrightsKey) {
    return {
      updated: new Date().toISOString(),
      teams: [],
      quotaRemaining: null,
      error: 'Outrights market not available upstream',
    };
  }
  const { data, quotaRemaining } = await oddsFetch(
    `/sports/${outrightsKey}/odds/`,
    {
      regions: REGIONS,
      markets: 'outrights',
      oddsFormat: 'decimal',
      dateFormat: 'iso',
    },
  );
  const teams = aggregateBest(data);
  return {
    updated: new Date().toISOString(),
    teams,
    quotaRemaining,
    error: null,
  };
}

export default async function handler(req, res) {
  try {
    const payload = await withCache('outrights', CACHE_SECONDS, buildPayload);
    sendJson(res, 200, payload, 900, 1800);
  } catch (err) {
    sendJson(
      res,
      200,
      {
        updated: null,
        teams: [],
        quotaRemaining: err.quotaRemaining || null,
        error: err.message || 'Unknown error',
      },
      120,
      240,
    );
  }
}
