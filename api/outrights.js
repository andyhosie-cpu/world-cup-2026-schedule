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
import { discoverSportKeys, oddsFetch, withCache, sendJson, normaliseTeam } from './_lib.js';

const REGIONS = 'uk';
const CACHE_SECONDS = 1800;

// The 48 teams confirmed for FIFA World Cup 2026. Keyed by the normalised
// form returned by normaliseTeam() so we can map e.g. "Czech Republic"
// (Betfair's legacy name) onto the canonical display name "Czechia". Anything
// returned by the upstream API whose normalised name is NOT in this map is a
// non-qualifier the books left on the board (Italy, Denmark, Poland etc.)
// and is filtered out.
const TOURNAMENT_TEAMS = {
  // Group A
  'mexico': 'Mexico', 'south africa': 'South Africa', 'south korea': 'South Korea', 'czechia': 'Czechia',
  // Group B
  'canada': 'Canada', 'bosnia and herzegovina': 'Bosnia and Herzegovina', 'qatar': 'Qatar', 'switzerland': 'Switzerland',
  // Group C
  'brazil': 'Brazil', 'morocco': 'Morocco', 'scotland': 'Scotland', 'haiti': 'Haiti',
  // Group D
  'usa': 'USA', 'paraguay': 'Paraguay', 'australia': 'Australia', 'türkiye': 'Türkiye',
  // Group E
  'germany': 'Germany', 'curaçao': 'Curaçao', 'ivory coast': 'Ivory Coast', 'ecuador': 'Ecuador',
  // Group F
  'netherlands': 'Netherlands', 'japan': 'Japan', 'sweden': 'Sweden', 'tunisia': 'Tunisia',
  // Group G
  'belgium': 'Belgium', 'egypt': 'Egypt', 'iran': 'Iran', 'new zealand': 'New Zealand',
  // Group H
  'spain': 'Spain', 'cape verde': 'Cape Verde', 'saudi arabia': 'Saudi Arabia', 'uruguay': 'Uruguay',
  // Group I
  'france': 'France', 'senegal': 'Senegal', 'iraq': 'Iraq', 'norway': 'Norway',
  // Group J
  'argentina': 'Argentina', 'algeria': 'Algeria', 'austria': 'Austria', 'jordan': 'Jordan',
  // Group K
  'portugal': 'Portugal', 'dr congo': 'DR Congo', 'uzbekistan': 'Uzbekistan', 'colombia': 'Colombia',
  // Group L
  'england': 'England', 'croatia': 'Croatia', 'ghana': 'Ghana', 'panama': 'Panama',
};

function aggregateBest(eventList) {
  // The outrights endpoint returns one or more "events" (usually one - the
  // tournament). Each event has bookmakers -> markets (outrights) -> outcomes.
  //
  // For each team in the 48-team tournament, pick the HIGHEST decimal price
  // across bookmakers - that is the best return per stake for the punter.
  // Non-qualifier names (Italy, Denmark etc.) are dropped, and legacy aliases
  // like "Czech Republic" are merged onto the canonical "Czechia".
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
        const canonical = TOURNAMENT_TEAMS[normaliseTeam(out.name)];
        if (!canonical) continue;
        const entry = { price, bookmaker: bm.title || bm.key };
        const prev = byTeam[canonical];
        if (!prev || price > prev.price) byTeam[canonical] = entry;
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
