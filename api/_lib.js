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
  'turkiye': 'türkiye',
  'korea republic': 'south korea',
  'republic of korea': 'south korea',
  'czech republic': 'czechia',
  "côte d'ivoire": 'ivory coast',
  "cote d'ivoire": 'ivory coast',
  'ivory coast': 'ivory coast',
  'cape verde': 'cape verde',
  'cabo verde': 'cape verde',
  'dr congo': 'dr congo',
  'democratic republic of the congo': 'dr congo',
  'congo dr': 'dr congo',
  // Bosnia & Herzegovina vs Bosnia and Herzegovina - upstream uses ampersand
  'bosnia & herzegovina': 'bosnia and herzegovina',
  'bosnia and herzegovina': 'bosnia and herzegovina',
  // Curaçao often shows up without the cedilla upstream
  'curacao': 'curaçao',
  'curaçao': 'curaçao',
};

export function normaliseTeam(raw) {
  if (!raw) return '';
  // Lowercase, trim, and collapse "&" to "and" so the lookup is forgiving.
  const lower = String(raw).trim().toLowerCase().replace(/\s*&\s*/g, ' and ');
  return NAME_MAP[lower] || lower;
}

/**
 * Build a join key: YYYY-MM-DD|teamA|teamB where teams are normalised and
 * sorted alphabetically so home/away order does not matter.
 *
 * The date component is the ET-local calendar date (UTC-4 in June/July 2026,
 * EDT) so it lines up with the FIFA-published schedule the front-end uses.
 * Without this, late-evening ET matches roll to the next UTC day and the
 * front-end lookup misses.
 */
const ET_OFFSET_MS = 4 * 60 * 60 * 1000;

export function joinKey(commenceISO, homeTeam, awayTeam) {
  const utc = new Date(commenceISO);
  const et = new Date(utc.getTime() - ET_OFFSET_MS);
  const yyyy = et.getUTCFullYear();
  const mm = String(et.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(et.getUTCDate()).padStart(2, '0');
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
    // Limit to active soccer sports whose title mentions "world cup".
    // Drop qualifiers, the women's tournament, and the recently-completed
    // Club World Cup - we want the men's FIFA World Cup itself.
    const candidates = data.filter((s) => {
      if (s.group !== 'Soccer') return false;
      if (!s.active) return false;
      const title = (s.title || '').toLowerCase();
      if (!title.includes('world cup')) return false;
      if (title.includes('qualifier')) return false;
      if (title.includes('club')) return false;
      if (title.includes('women')) return false;
      return true;
    });
    // Within those, the outrights sport carries has_outrights=true; the
    // fixture sport carries has_outrights=false. Prefer the exact title
    // "FIFA World Cup" / "FIFA World Cup Winner" if present.
    const exactMatch = candidates.find(
      (c) => (c.title || '').toLowerCase() === 'fifa world cup',
    );
    const exactOutrights = candidates.find(
      (c) => (c.title || '').toLowerCase() === 'fifa world cup winner',
    );
    let matchKey = exactMatch?.key || null;
    let outrightsKey = exactOutrights?.key || null;
    // Fallback: first matching candidate of each shape.
    if (!matchKey) {
      const c = candidates.find((c) => !c.has_outrights);
      if (c) matchKey = c.key;
    }
    if (!outrightsKey) {
      const c = candidates.find((c) => c.has_outrights);
      if (c) outrightsKey = c.key;
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
