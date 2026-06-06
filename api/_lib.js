/**
 * Shared helpers for the three Odds-API serverless functions.
 *
 * - Team-name normalisation matching the front-end (so join keys line up).
 * - Sport-key discovery via /v4/sports (free call) cached for the warm-instance lifetime.
 * - Simple TTL cache keyed by string.
 * - Apartment-friendly fetch wrapper that also surfaces the x-requests-remaining header.
 */

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

/**
 * Lowercase + map to canonical names. Mirrors the table in the front-end
 * so server and client produce the same join keys.
 */
const NAME_MAP = {
  'united states': 'usa',
  'turkey': 'türkiye',
  'korea republic': 'south korea',
  'republic of korea': 'south korea',
  'czech republic': 'czechia',
  "côte d'ivoire": 'ivory coast',
  'cote d\'ivoire': 'ivory coast',
  'ivory coast': 'ivory coast',
  'cape verde': 'cape verde',
  'cabo verde': 'cape verde',
  'dr congo': 'dr congo',
  'democratic republic of the congo': 'dr congo',
  'congo dr': 'dr congo',
};

export function normaliseTeam(raw) {
  if (!raw) return '';
  const lower = String(raw).trim().toLowerCase();
  return NAME_MAP[lower] || lower;
}

/**
 * Build a join key: YYYY-MM-DD|teamA|teamB where teams are normalised and
 * sorted alphabetically so home/away order does not matter.
 */
export function joinKey(commenceISO, homeTeam, awayTeam) {
  const date = new Date(commenceISO);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;
  const a = normaliseTeam(homeTeam);
  const b = normaliseTeam(awayTeam);
  const [first, second] = [a, b].sort();
  return `${dateStr}|${first}|${second}`;
}

/**
 * Module-scope TTL cache. Returns cached value if fresh, otherwise calls the
 * fetcher and stores its result. Errors are propagated, never cached.
 */
const _store = new Map();
export async function withCache(key, ttlSeconds, fetcher) {
  const now = Date.now();
  const hit = _store.get(key);
  if (hit && now - hit.ts < ttlSeconds * 1000) {
    return hit.value;
  }
  const value = await fetcher();
  _store.set(key, { ts: now, value });
  return value;
}

/**
 * Fetch from The Odds API. Always returns { data, quotaRemaining }.
 * Throws on non-2xx so callers can wrap with try/catch and return a friendly
 * error payload to the client.
 */
export async function oddsFetch(path, params = {}) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    const err = new Error('ODDS_API_KEY environment variable is not set');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const url = new URL(`${ODDS_API_BASE}${path}`);
  url.searchParams.set('apiKey', apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString());
  const quotaRemaining = res.headers.get('x-requests-remaining');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Odds API ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    err.quotaRemaining = quotaRemaining;
    throw err;
  }
  const data = await res.json();
  return { data, quotaRemaining };
}

/**
 * Discover the FIFA World Cup sport keys via /v4/sports (which is free and
 * does not count against quota). Returns { matchKey, outrightsKey } cached
 * for 12 hours per warm instance.
 *
 * - matchKey: the sport with World Cup in the title and has_outrights=false
 * - outrightsKey: the same fixture's outrights companion, has_outrights=true
 */
export async function discoverSportKeys() {
  return withCache('sport-keys', 12 * 3600, async () => {
    const { data } = await oddsFetch('/sports', { all: 'true' });
    const candidates = data.filter((s) => {
      if (s.group !== 'Soccer') return false;
      const blob = `${s.title || ''} ${s.description || ''}`.toLowerCase();
      return blob.includes('world cup');
    });
    let matchKey = null;
    let outrightsKey = null;
    for (const c of candidates) {
      if (c.has_outrights) {
        if (!outrightsKey) outrightsKey = c.key;
      } else {
        if (!matchKey) matchKey = c.key;
      }
    }
    return { matchKey, outrightsKey };
  });
}

/**
 * Helper to send a uniform JSON response with permissive caching headers.
 */
export function sendJson(res, status, payload, sMaxAgeSeconds, swrSeconds) {
  res.setHeader('Content-Type', 'application/json');
  if (sMaxAgeSeconds != null) {
    const swr = swrSeconds != null ? swrSeconds : sMaxAgeSeconds * 2;
    res.setHeader(
      'Cache-Control',
      `public, s-maxage=${sMaxAgeSeconds}, stale-while-revalidate=${swr}`,
    );
  }
  res.status(status).send(JSON.stringify(payload));
}
