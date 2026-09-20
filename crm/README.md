# OCB CRM

Internal dashboard for OpenChainBench: traffic (PostHog), data health (the
worker's blob), harness health (Prometheus targets) and the Dune plan. One
password, one Railway service, no database.

## What it shows

| Page | Source | Numbers |
|---|---|---|
| Overview | PostHog, blob, Prometheus | visitors, pageviews, sessions (7 d vs previous 7 d), **AI-referred visitors** (ChatGPT, Perplexity, Claude, Gemini, Copilot, …), search-referred visitors, 28 d daily series, 12 w weekly series with the AI share, channels, AI domains, sections |
| Pages | PostHog | sections week over week, biggest gains and losses, top 100 pages (filter by section), entry pages |
| Audience | PostHog | new vs returning, bounce, countries, devices, UTM sources, referring domains with their channel |
| Data health | blob, Prometheus, Dune | live / stale (> 24 h) / expired (> 7 d) benches per category, benches needing attention, scrape targets down, Dune credits and period end, the daily history kept on the volume |

The site captures `$pageview` only (autocapture off, nobody identified), so
every traffic number is a pageview aggregate and a visitor is a device cookie.
Events from staging and localhost are excluded (`properties.$host`).

## How it stays under the PostHog rate limit

PostHog allows **2400 query requests per hour per organisation**, shared by
every key and every team member. This app never queries in the request path:

- a refresh runs a **fixed list of 11 HogQL queries**, one at a time
  (`lib/traffic.ts`), and writes a snapshot; pages read the snapshot;
- the scheduler (`instrumentation.ts`) refreshes every `REFRESH_MINUTES`
  (default 60): **11 queries per hour, about 0.5 % of the organisation's
  budget**;
- the Refresh button is refused for 10 minutes after any refresh;
- a local budget (`POSTHOG_HOURLY_BUDGET`, default 300 per rolling hour) is a
  second guard; a 429 or an exhausted budget stops the batch, the sections that
  did not run keep their previous values, and the next scheduled refresh
  retries.

A section that fails keeps its previous value and shows its error in the
header, so an upstream blip never blanks the dashboard.

## Run locally

```bash
cd crm
pnpm install --ignore-workspace
cp .env.example .env.local   # fill CRM_PASSWORD, POSTHOG_*, optionally DUNE_API_KEY
set -a; source .env.local; set +a
SNAPSHOT_DIR=.snapshots pnpm refresh   # one refresh from the CLI
SNAPSHOT_DIR=.snapshots pnpm dev       # http://localhost:3210
pnpm test && pnpm typecheck
```

## Deploy (Railway)

The service is `ocb-crm` in the Railway project `Dashboard OpenChainBench`,
built from `crm/Dockerfile`, with a volume mounted at `/data` for the snapshot
and its history.

```bash
cd crm
railway link            # project Dashboard OpenChainBench, service ocb-crm
railway up --detach     # uploads this directory, builds the Dockerfile
railway logs
```

Variables (Railway service settings): `CRM_PASSWORD`, `POSTHOG_PERSONAL_API_KEY`,
`POSTHOG_PROJECT_ID`, optionally `DUNE_API_KEY`, `POSTHOG_HOURLY_BUDGET`,
`REFRESH_MINUTES`. `SNAPSHOT_DIR=/data` and `PORT` are set on the service.

## Adding a metric

1. Add a query to `QUERIES` in `lib/traffic.ts` and its mapping in
   `loadTrafficSection`; the refresh budget grows by one query per hour.
2. Extend the `Traffic` type, render it on a page.
3. `pnpm test`: the query test checks every query stays scoped to
   `$pageview` on the production host.

Non-PostHog sources go in `lib/ocb.ts` and get a `step()` in `lib/snapshot.ts`.
