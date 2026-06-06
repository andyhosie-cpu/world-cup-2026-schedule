# World Cup 2026 — Schedule + Live Scores + Odds

A single-page browser app that shows the full FIFA World Cup 2026 fixture list with filters, search, and an expandable knockout bracket. Layered on top: live scores and best UK bookmaker odds, refreshed automatically. The Odds API key lives server-side only.

## Files

```
wc-app/
  public/index.html      Single-file vanilla-JS UI (the existing schedule plus the new live data layer)
  api/scores.js          Vercel Node function - live + recent scores, 90s in-memory cache
  api/odds.js            Vercel Node function - h2h best UK prices, 10min in-memory cache
  api/outrights.js       Vercel Node function - tournament-winner outright market, 30min in-memory cache
  api/_lib.js            Shared: sport-key discovery, team normalisation, join key, fetch wrapper
  vercel.json            Minimal Vercel config
  package.json           Marks the api/ folder as ESM
  .gitignore             node_modules, .env.local, .vercel
  README.md              This file
```

## Prerequisites

- Node.js (any recent version — Vercel CLI needs it)
- A free account at https://vercel.com and the CLI: `npm i -g vercel`
- An Odds API key from https://the-odds-api.com (the free tier ships 500 credits/month)

## Local development

```bash
cd wc-app
echo "ODDS_API_KEY=YOUR_KEY_HERE" > .env.local   # if you have not already
vercel dev
```

Open http://localhost:3000 — the page loads, then within a second or two the scores stat-tag and odds chips populate. `vercel dev` runs the Node functions locally with hot reload.

## Deploy

```bash
vercel deploy                              # first preview deploy, links the project
vercel env add ODDS_API_KEY production     # paste the key when prompted
vercel deploy --prod                       # production deploy that reads the env var
```

If you link the GitHub repo to the Vercel project (via the dashboard or `vercel git connect`), future `git push` operations auto-deploy. No need to run `vercel deploy` manually after that.

## Monitoring API quota

Two ways to see your remaining quota:

1. **In the page itself**: the status strip near the summary bar shows `quota: 487 left`, sourced from the upstream `x-requests-remaining` header on every response.
2. **On the Odds API dashboard**: https://the-odds-api.com → account page.

## Cost — honest estimate

The free tier is **500 credits/month**. Per-call costs:

- `/api/scores` upstream: 2 credits (1 region implied via `daysFrom`)
- `/api/odds` upstream: 1 credit (1 region × 1 market = h2h)
- `/api/outrights` upstream: 1 credit
- `/sports` discovery: free

With default cache TTLs (scores 90s, odds 10min, outrights 30min):

- One tab open, one hour of active viewing: ~80 score credits + ~6 odds credits ≈ **86 credits/hour**.
- One user, ~2 hours/day across the 32-day tournament: roughly **5,000 credits** total.
- Casual lookup (one or two page-loads per day, short sessions): **~50–150 credits/day** → ~1,500–4,500/month.

The free tier will probably run out partway through the tournament if you're using it daily. Two cheap ways to extend:

1. **Stretch the in-function cache TTLs**: change `CACHE_SECONDS` at the top of each `api/*.js` file. Doubling the scores TTL to 180s halves quota use; the only downside is scores can be up to 3 minutes stale.
2. **Upgrade tiers** at https://the-odds-api.com (paid plans start cheap).

The page also pauses polling whenever the tab is hidden — quota-friendly by default.

## Swap bookmaker region

In `api/odds.js` and `api/outrights.js`, change the `REGIONS` constant:

```js
const REGIONS = 'uk';   // change to 'eu' | 'us' | 'au' as needed
```

Multiple regions can be combined with commas, e.g. `'uk,eu'` — note this multiplies the credit cost per call.

## How the data joins to the static fixture list

The frontend and the serverless functions both build a stable `joinKey` per match: `YYYY-MM-DD|teamA|teamB` (teams lowercased, mapped via a normalisation table, then sorted alphabetically). That key is the same on both sides, so a row in the static schedule lines up with the right live score or odds row from upstream without any per-match lookup table. The normalisation table is in both `public/index.html` and `api/_lib.js` — keep them in sync if you ever need to add a team name variant.

## Graceful degradation

Every upstream error is caught at the function layer and returned to the client as a 200 with an `error` field. The frontend silently keeps whatever it last had and shows a `Scores: error` tag in the status strip. The schedule, filters, search, sorting, and the knockout bracket continue to work even if both `/api/scores` and `/api/odds` are dead.
