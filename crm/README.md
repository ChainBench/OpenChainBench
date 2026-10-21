# OCB CRM

Internal dashboard for OpenChainBench: traffic (PostHog), data health (the
worker's index blob), harness health (Prometheus targets) and the Dune plan.
One shared password, per-login sessions, one Railway service, no database.

## What it shows

| Page | Source | Numbers |
|---|---|---|
| Overview | PostHog, blob, Prometheus | visitors, pageviews, sessions (7 d vs previous 7 d), **AI-referred visitors** (ChatGPT, Perplexity, Claude, Gemini, Copilot, …), search-referred visitors, 28 d daily series, 12 w weekly series with the AI share, channels, AI domains, sections |
| Pages | PostHog | sections week over week, biggest gains and losses, top 100 pages (filter by section), entry pages |
| Audience | PostHog | new vs returning, bounce, Core Web Vitals p75 by device, time on page by section, countries, devices, UTM sources, referring domains with their channel |
| Actions | PostHog custom events | outbound clicks by destination host (visitors sent to providers), copies (endpoint, API URL, MCP, embed) per bench, searches with no result (content gaps), search queries with the result picked |
| Data health | index blob, Prometheus, Dune | live / stale (> 24 h) / expired (> 7 d) benches per category, benches needing attention, scrape targets down, Dune credits and period end, the daily history kept on the volume |

The site captures `$pageview`, `$pageleave` and three custom events
(`outbound_click`, `copy`, `search`, see `src/lib/analytics.ts`; autocapture
off, nobody identified). Traffic pages read `$pageview`, the Actions page the
custom events; a visitor is a device cookie. Events from staging and
localhost are excluded (`properties.$host`).

Bench health reads `aggregate/index.json` (every bench with its status and
last run), not the sitemap blob: the worker drops expired chain RPC benches
from the sitemap before publishing, which is exactly what this page must show.

## How it stays under the PostHog rate limit

PostHog allows **2400 query requests per hour per organisation**, shared by
every key and every team member. This app never queries in the request path:

- a refresh runs a **fixed list of 19 HogQL queries**, one at a time
  (`lib/traffic.ts`), and writes a snapshot; pages read the snapshot;
- the scheduler (`instrumentation.ts`) refreshes every `REFRESH_MINUTES`
  (default 15): **76 queries per hour, 3.2 % of the organisation's budget**;
- the Refresh button is refused for 5 minutes after any refresh;
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
cp .env.example .env.local   # fill CRM_PASSWORD, CRM_SESSION_SECRET, POSTHOG_*, optionally DUNE_API_KEY
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

**That recipe only works from the main checkout, not from a worktree.**
`railway up` walks up to the repository root and uploads that, so from a
worktree it sends the whole repository; Railpack then finds the repo-root
`pnpm-workspace.yaml`, ignores `crm/Dockerfile` entirely, and the build dies on
`pnpm install --frozen-lockfile` with `ERROR packages field missing or empty`
(deployment `e4cbecc6`, 2026-09-30). What gets uploaded is what decides the
builder, so the fix is to make `crm/` the root of the upload by copying it
somewhere that is not a repository:

```bash
rsync -a --exclude node_modules --exclude .next --exclude .snapshots \
  --exclude .env.local crm/ /tmp/crm-deploy/
cd /tmp/crm-deploy
railway up --ci --service ocb-crm \
  --project bab1e866-89a4-4aa7-a1d7-c461869c71bd --environment production
```

`--ci` streams the build and exits, which is how you see which builder ran:
`[build 6/6] RUN pnpm build` means the Dockerfile was used. `--project` requires
`--environment` alongside it. Confirm with `railway deployment list --service
ocb-crm`, because a failed deploy leaves the previous container serving: the
dashboard keeps working and the failure looks like nothing happened. The
refresh line in `railway logs` names the section count, which is the cheapest
proof the new build is live.

Variables (Railway service settings): `CRM_PASSWORD`, `CRM_SESSION_SECRET`, `POSTHOG_PERSONAL_API_KEY`,
`POSTHOG_PROJECT_ID`, `VERCEL_API_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, optionally
`DUNE_API_KEY`, `POSTHOG_HOURLY_BUDGET`, `REFRESH_MINUTES`. `SNAPSHOT_DIR=/data` and `PORT`
are set on the service.

The three `VERCEL_*` variables feed the bot and agent section, which reads Vercel
Observability rather than PostHog. PostHog cannot answer that question: its SDK is
client-side JavaScript and the server capture covers three routes, two of them cached,
so a crawler reading an ISR-cached page is invisible to it. Without the variables the
section says so and every other section is unaffected. See `lib/vercel-obs.ts`.

## Sessions

The cookie is `nonce.expiry.signature`, signed with `CRM_SESSION_SECRET` (random,
not the password, so a leaked cookie gives nothing to brute force) and valid
only while its nonce is listed in `/data/sessions.json`: logout revokes it,
rotating either variable logs everyone out. Login attempts are limited to 10
per client per 15 minutes. The password needs 12 characters or more, the
secret 16.

Module state (snapshot cache, refresh mutex, PostHog budget, login counters)
lives on `globalThis` and the snapshot file is re-read whenever its mtime
moves: Next bundles `instrumentation.ts` and the routes in different layers,
and each layer gets its own module instance otherwise.

## Adding a metric

1. Add a query to `QUERIES` in `lib/traffic.ts` and its mapping in
   `loadTrafficSection`; the refresh budget grows by one query per hour.
2. Extend the `Traffic` type, render it on a page.
3. `pnpm test`: the query test checks every query stays scoped to
   `$pageview` on the production host.

Non-PostHog sources go in `lib/ocb.ts` (or their own module) and get a
`step()` in `lib/snapshot.ts`.


