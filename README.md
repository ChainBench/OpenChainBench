# OpenChainBench

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20800312.svg)](https://doi.org/10.5281/zenodo.20800312)

> Open, reproducible benchmarks for crypto infrastructure. aggregators, bridges, RPCs, price feeds. Same metric, same conditions, every provider. Live at [openchainbench.com](https://openchainbench.com).

OpenChainBench publishes one benchmark at a time, each one shipping with the script that produces its data. The goal is to make performance an observable property of crypto infra. measured in the open, by anyone who wants to add a provider or a metric.

The project is community-run, MIT-licensed, and accepts PRs from any party including the providers it benchmarks.

## What's inside

```
benchmarks/                 Spec files. one YAML per published benchmark (30 and counting)
├── aggregator-head-lag.yml     №001 · onchain data provider latency
├── bridge-quote-latency.yml    №002 · cross-chain bridge quote latency
├── hyperliquid-frontends.yml   №030 · HL builder-code revenue (100+ frontends)
├── perp-funding.yml            №036 · perp funding rates across venues
├── pm-rate-limits.yml          №037 · prediction-market API rate limits
├── …                           (run `ls benchmarks/` for the full list)
└── README.md                   Spec format reference + submission guide

harnesses/                  The runners that produce the metrics (18 dirs)
├── aggregator-head-lag/    Go service: WebSocket monitor (:2112/metrics)
├── bridge-monitor/         Go service: 4-bridge quote loop + execution (:9090/metrics)
├── hyperliquid-frontends/  Go service: tails a local hl-node fill stream;
│                           feeds benches №030/№036 + HIP-3 deployers,
│                           builder registry in builders.json (100+ entries)
├── l1-finality/            Go service: per-chain finality latency probe
├── …                       (oracle-deviation, solana-tx-landing, validator-yield, …)
└── README.md               Contract for new harnesses

worker/                     Materialization worker (Railway): sweeps every bench
                            against Prometheus every 60s, publishes snapshots
                            to the Redis store the site reads

alternatives/               YAML-driven /alternatives/<slug> SEO landing pages
└── README.md               Format for "Pump Portal alternatives", "Relay alternatives", …

infrastructure/             Shared services every harness depends on
└── prometheus/             Single shared Prometheus that scrapes all harnesses

src/                        Next.js 16 site (App Router, ISR, Tailwind v4)
├── app/                    Pages:
│                             /             — hero ("Highest accuracy at every price point")
│                                             with animated radar dial, live Network Ecosystem,
│                                             Latest deployed benchmarks table
│                             /benchmarks   — card grid (3-col) with category pill filter + search
│                             /providers    — "Products" list with brand logos, benchmarks /
│                                             top-1 counts (Top-1 green when > 0)
│                             /contribute   — 6-step tutorial + federation / timeline cards
│                             /methodology  — design principles + statistical conventions
│                             /benchmarks/[slug] — bench detail with card-wrapped chart + ledger
│                             /alternatives, /press, /mcp, /about
├── components/
│   ├── site-header.tsx, site-footer.tsx, site-banner.tsx, site-logo.tsx
│   ├── theme-toggle.tsx     Sun/moon toggle, html.dark class strategy, localStorage-persisted
│   ├── hero-radar.tsx       Animated SVG dial on the home hero
│   ├── benchmark-card.tsx, benchmark-grid.tsx, home-bench-table.tsx
│   ├── time-series-chart, ledger-table, region-grid, chain-tabs, …
│   └── live/                Live page: dashboard, ticker, chart, compact-feed
├── data/
│   ├── benchmarks.ts        Spec loader (YAML + materialized snapshots → Benchmark[])
│   └── provider-registry.ts Per-provider description, URL, Twitter handle
└── lib/
    ├── prometheus.ts        Prometheus HTTP client + spec/formatting helpers
    ├── providers.ts         Aggregates each provider's benchmark appearances
    ├── brand.ts             Vivid brand-color table per chain / provider (legible both modes)
    └── live/                Live page domain logic (types, config, chains, format, buckets)
```

The live dashboard at the top of `/` is fed by a separate **stream relay** living in the
[`mobula-monorepo`](https://github.com/MobulaFi/mobula-monorepo) at
`miniapps/ocb-stream-relay/`. It is hosted by Mobula because it holds an
upstream API key; the browser talks to it directly over WebSocket. Vercel
only serves the static page shell. See [`docs/architecture.md`](./docs/architecture.md#the-live-page)
for the data flow.

## Cite OpenChainBench

Every benchmark is licensed CC-BY-4.0 and exposed through a small set of
machine-readable endpoints so journalists, devs, and AI agents can quote
us without screenshotting:

| Endpoint | Audience | What it returns |
|---|---|---|
| [`/llms.txt`](https://openchainbench.com/llms.txt) | LLM crawlers (ChatGPT, Claude, Perplexity, Gemini) | Plain-text index of every benchmark + links to JSON. Follows the [llmstxt.org](https://llmstxt.org) convention. |
| [`/api/citable`](https://openchainbench.com/api/citable) | Devs, agents | Flat JSON: every benchmark with current value, leader, headline sentence, citation URL, OG image URL. |
| [`/api/stat/<slug>`](https://openchainbench.com/api/stat/aggregator-head-lag) | Devs, agents | Single benchmark: full rankings, sparkline (24h), methodology, paste-ready quote, attribution URL. |
| [`/api/freshness`](https://openchainbench.com/api/freshness) | Live UI, dashboards | Tiny `{slug → asOf ms}` map. Edge-cached 5 s, polled by the on-page "Live" indicator every 8 s for ~15-20 s p99 staleness. |
| [`/api/llm-context`](https://openchainbench.com/api/llm-context) | LLMs | Every benchmark with rankings + methodology in one Markdown blob. Paste into a system prompt for "here's everything you need to answer questions about crypto-infra performance today". |
| [`/benchmarks/<slug>/opengraph-image`](https://openchainbench.com/benchmarks/aggregator-head-lag/opengraph-image) | Twitter/Slack/Discord/iMessage | 1200×630 PNG with the current value, leader, sparkline, watermark. Returned automatically as the OG image when someone shares a benchmark link. |
| [`/benchmarks/<slug>/share-card?template=...&theme=...`](https://openchainbench.com/benchmarks/aggregator-head-lag/share-card) | Manual export | 5 share templates (ranking, snapshot, headline, compare, leaderboard) — supports `?theme=dark` so the export matches the user's site theme. |
| [`/api/openapi.json`](https://openchainbench.com/api/openapi.json) | LangChain, Custom GPTs, generic clients | OpenAPI 3.1 schema describing every endpoint. |
| [`/api/mcp/mcp`](https://openchainbench.com/api/mcp/mcp) | MCP-capable agents (Claude Desktop, Cursor) | MCP server exposing `list_benchmarks`, `get_benchmark`, `query_prom` tools. Streamable HTTP transport. |
| [`/api/badge/<bench>/<provider>`](https://openchainbench.com/api/badge/aggregator-head-lag/mobula) | Provider sites, READMEs, blogs | Embeddable SVG badge with the provider's current rank and headline figure. 360×36, cache-aware. |

Each bench detail page also has a **Copy API URL** strip under the title. one click and a journalist has the JSON endpoint for live numbers.

### How journalists cite us

```text
"Mobula leads head lag at 0.8s (p50, 24h) on Fastest onchain data provider.
Source: OpenChainBench (https://openchainbench.com/benchmarks/aggregator-head-lag)"
```

This is the `headlineSentence` exposed on `/api/stat/<slug>`. The page URL is stable, the OG preview unfurls automatically with the current value, and the data is CC-BY-4.0.

### Product pages

Every product (provider) that appears in at least one benchmark spec gets a page at `/providers/<slug>` (the URL stays `providers/` for SEO continuity; the UI labels everything as "Products"). The list at [`/providers`](https://openchainbench.com/providers) is now a flat avatar list with each row showing:

- the product's brand logo + name + optional type pill (intent / protocol / aggregator / relay)
- the categories it appears in, colored by category (Aggregators / Bridges / Blockchains / Trading)
- two right-aligned counts: **Benchmarks** (total appearances) and **Top 1** (green when > 0, gray otherwise)

A category pill filter and `⌘K` search box sit above the list. Drafts (products from harnesses temporarily unreachable) still surface in the list rather than disappearing — keeps the directory stable when a single harness is down.

The bench detail page also keeps the per-product registry (description, URL, Twitter handle) from [`src/data/provider-registry.ts`](./src/data/provider-registry.ts) and renders an embeddable badge for every bench where the product is currently #1.

### How agents query us

**Via MCP (recommended)**: OpenChainBench ships an MCP server at `https://openchainbench.com/api/mcp/mcp` (Streamable HTTP transport, no auth). Any MCP-capable client (Claude Desktop, Cursor, ChatGPT custom tools, generic MCP clients) can connect and discover:

- **3 tools**: `list_benchmarks`, `get_benchmark(slug, chain?, region?)`, `query_prom(query, windowSec?, steps?)` — `query_prom` is scoped to the published benchmark metric namespaces so the public endpoint can't be used to walk the underlying Prometheus catalog.
- **1 resource template**: `openchainbench://benchmark/{slug}` — every live benchmark is also exposed as an MCP resource (Markdown + JSON), so an agent can pin a bench into its context as a long-lived document instead of re-fetching every turn.

#### Install in Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (or the equivalent on your OS):

```json
{
  "mcpServers": {
    "openchainbench": {
      "url": "https://openchainbench.com/api/mcp/mcp"
    }
  }
}
```

Restart Claude Desktop. The tools appear under the 🔌 icon; ask *"what's the fastest crypto data aggregator on Base today?"* and watch it call `get_benchmark` live.

#### Install in Cursor

Settings → MCP → Add server → URL `https://openchainbench.com/api/mcp/mcp`.

**Via REST**: hit `/api/citable` once to discover everything, then `/api/stat/<slug>` for specifics. Both are zero-auth, edge-cached for 60 s. For just the live freshness, `/api/freshness` is a few hundred bytes and refreshes every 5 s at the edge.

## How a benchmark gets data. federation

OpenChainBench is a federation of independently-hosted harnesses. Each spec declares the Prometheus its harness writes to. nothing forces every contributor onto the same instance.

```
[Mobula's infra]         [Contributor B's infra]      [Provider C's infra]
   harness exposes          harness exposes               harness exposes
   /metrics on              /metrics on                   /metrics on
   <public HTTPS URL>       <public HTTPS URL>            <public HTTPS URL>
        │                          │                              │
        ▼                          ▼                              ▼
   Prometheus A               Prometheus B                   Prometheus C
   (operator's,               (operator's,                   (operator's,
   public read API)           public read API)               public read API)
        │                          │                              │
        └──────────────────────────┼──────────────────────────────┘
                                   ▼
                          openchainbench.com
                          (Next.js site on Vercel)
                          queries spec.prometheus.url
                          declared in each YAML
```

Each harness is run by whoever wrote it. Mobula for the existing aggregator and bridge benchmarks, independent contributors for any future ones, providers for self-benchmarks of their own services. They never share API keys with the project. They expose `/metrics` over HTTPS to **their own** Prometheus, and that Prom's read API is what the site queries.

Prometheus is queried by a **materialization worker** (`worker/index.ts`, a Railway service colocated with the Prom), not by the site at request time. The worker sweeps every bench every 60 s via the standard HTTP API (`/api/v1/query`, `/api/v1/query_range`), applies per-provider carry-forward (a provider whose queries fail this sweep keeps its last good values, marked with a `staleSince` timestamp), and publishes complete, atomic snapshots to a Redis store. The site reads snapshots only (`READ_FROM_STORE=1`). Resilience layers, in order:

1. **Carry-forward in the worker.** Transient per-provider query failures never produce holes in a leaderboard — last good values are served with honest staleness metadata instead.
2. **Snapshot freshness gate with live fallback.** If a snapshot is missing or older than the acceptance window (worker down), the site falls back to the original live-Prometheus loader for that render.
3. **Per-bench `unstable_cache` revalidate 60 s + ISR** on top of the store read, so a Redis blip on bench A does not poison bench B and pages stay static-fast.
4. **Vercel edge cache** (`s-maxage` + `stale-while-revalidate`) on every public route. A worker heartbeat key surfaces sweep staleness for ops.

A spec's Prometheus URL goes through a two-layer SSRF guard: a schema-time rejection of non-HTTPS / RFC1918 / link-local / metadata IPs at PR-validate time (`pnpm validate`), and a runtime DNS resolution that refuses if the hostname currently lands on a private address. Plus `redirect: "manual"` on every Prom fetch so a 3xx into a private host gets blocked too.

## The live dashboard on /

A second data path feeds the live dashboard at the top of [openchainbench.com](https://openchainbench.com): a real-time stream of swap events from Mobula's fast-trade WebSocket. The data **does not flow through Prometheus**. it goes directly from the relay's WebSocket to the browser, with the Vercel site acting as a thin static shell.

```
[Mobula fast-trade WS]      [Mobula REST /lighthouse,/all]
        │                              │
        ▼                              ▼
                ocb-stream-relay (Railway)
                 │  - Multi-resolution chart store:
                 │      10m window @ 5s buckets
                 │      1h  window @ 30s buckets
                 │      24h window @ 10min buckets
                 │  - 24h vol counter
                 │  - lighthouse poller (5min)
                 │  - mcap poller (10min)
                 │  - snapshot sent on each client connect
                 ▼  wss://ocb-stream-relay-...up.railway.app/ws
                browser (openchainbench.com)
                Next.js Client Component, no Vercel relay
```

Single Railway box, in-memory fan-out. Cost stays flat regardless of viewer count. The dashboard collapses to a one-line ticker by default and expands to a cumulative-volume chart with hover crosshair, per-chain tooltip, and live trade feed when toggled. The chart's range picker (10 min / 1 hour / 24 h) reads from the relay's three ring buffers and the x-axis auto-fits to the data extent when a buffer is still filling. See [`docs/architecture.md`](./docs/architecture.md#the-live-page) for the full diagram.

## Architecture

| Layer | Where it runs | Notes |
|---|---|---|
| Site (Next.js 16, ISR) | Vercel | Bench detail pages on `revalidate: 60`, static hubs. Reads materialized snapshots from the Redis store (`READ_FROM_STORE=1`) with a live-Prom fallback. Zero secrets beyond the store URL. |
| Materialization worker | Railway (`ocb-materialize-worker`) | Sweeps every bench against Prometheus every 60 s, applies per-provider carry-forward, publishes atomic snapshots to Redis. Its image clones OCB `dev` at build — rebuild it after spec provider-list changes. |
| Snapshot store | Railway Redis | Atomic per-(bench, variant) snapshot blobs + heartbeat key. |
| Prometheus | A small Railway service | Shared OpenChainBench time-series store. Open access (read-only public API). |
| Harnesses | Wherever the contributor wants to host them | Railway, Fly, Cloud Run, a VPS. each contributor owns their own runtime, secrets, and budget. |
| Live-stream relay | Mobula's Railway | Holds the Mobula API key, fans out Mobula fast-trade events to browsers. Not in this repo. |

The split is intentional: Vercel for the globally-cached read path, Prometheus for the time-series store, and any compute platform for the long-running data producers. Nobody other than the harness operator needs the harness's secrets.

A background **health-check cron** on Vercel (`/api/cron/health-check`, every 5 min) detects providers that have gone silent. It uses PromQL `present_over_time()` to test whether Prometheus has actually scraped a sample for a metric inside the freshness window, which works correctly for slow-cadence gauges where the value can be stable for minutes at a time. Sustained transitions (10 minute hysteresis) post a Slack message; the UI separately renders `availability: "unavailable"` for the affected provider rows.

## Running the site locally

```bash
pnpm install
pnpm dev              # http://localhost:3000
```

The site reads every `benchmarks/*.yml` at request time. Locally (no Redis store configured) it falls back to live Prometheus queries; specs whose data source the runtime can't reach render as drafts (no numbers, methodology only).

```bash
pnpm validate            # schema-lint every spec in benchmarks/
pnpm spec:dry-run <slug> # query Prometheus and print numbers, no rendering
pnpm test                # run unit tests (bun test src/)
pnpm check               # validate + typecheck + lint + test (pre-PR gate)
pnpm build               # production build
```

The live dashboard connects to the production relay by default. To point it at a local relay (see the relay README for instructions), set:

```bash
NEXT_PUBLIC_RELAY_WS_URL=ws://localhost:2112/ws pnpm dev
```

For production deployments, attaching a Vercel KV (or Upstash Redis via the Marketplace) is recommended but optional. Once connected, the env vars `KV_REST_API_URL` and `KV_REST_API_TOKEN` are injected automatically and the snapshot fallback activates. Without them the site behaves identically to a deployment without KV: a cold-start hit during a Prom blackout will fall through to a draft placeholder until the next successful scrape lands.

## Running a harness locally

Each harness is a standalone Go binary that exposes `/metrics` on a documented port (`:2112` for aggregator, `:9090` for bridge). They have no Prometheus / Grafana dependencies. that lives in [`infrastructure/`](./infrastructure/) and is shared.

```bash
cd harnesses/aggregator-head-lag
cp .env.example .env       # fill in API keys
go run ./cmd/script/       # or: docker build -t hh . && docker run -p 2112:2112 hh
```

To render the site against your local harness, run a local Prometheus scraping `localhost:<port>` (the [`infrastructure/prometheus/README.md`](./infrastructure/prometheus/README.md) has notes) and point the corresponding YAML's `prom_url` at it.

## Adding a benchmark

Full guide in [CONTRIBUTING.md](./CONTRIBUTING.md). For a concrete end-to-end example, read [`docs/walkthrough.md`](./docs/walkthrough.md). Short version:

1. **Open an issue** with the [📊 Propose a benchmark template](https://github.com/ChainBench/OpenChainBench/issues/new?template=new-benchmark.yml). Sketch the metric, providers, methodology. get feedback before you build. Want to brainstorm first? Use [Discussions → Ideas](https://github.com/ChainBench/OpenChainBench/discussions/categories/ideas) instead.
2. **Write the spec** at `benchmarks/<slug>.yml`. Format documented in [`benchmarks/README.md`](./benchmarks/README.md), validated by `src/lib/spec-schema.ts`.
3. **Build the harness** in `harnesses/<slug>/`. Any language works as long as it exposes `/metrics` over HTTPS with the metric names and labels your spec references. The harness is a data producer only. no Prometheus, Grafana, or Alertmanager packaging.
4. **Deploy the harness** on whatever infra fits. Railway, Fly, Cloud Run, a VPS, even a home server with a static IP. Expose `/metrics` over HTTPS at a stable public URL. You own the runtime, the secrets and the budget.
5. **Add a scrape entry** to `infrastructure/prometheus/prometheus.yml` pointing at your public URL so the shared Prometheus picks up your harness.
6. **Open a PR.** CI runs schema validation, typecheck, lint, and build. Once merged, a maintainer redeploys the central Prometheus and the site renders your benchmark on the next ISR cycle (≤ 60 s).

You never share API keys or wallet keys with the project. Your harness runs with your credentials, on your infra, on your budget. the maintainers only see the metric values your harness chooses to publish.

### Filtering by chain / dimension

A spec can declare `dimensions.chain` (or other dimensions) to expose a tab strip above the chart that filters every PromQL query by that label. Example from `benchmarks/aggregator-head-lag.yml`:

```yaml
dimensions:
  chain:
    - { value: all,    label: All chains }
    - { value: base,   label: Base }
    - { value: bnb,    label: BNB Chain }
    - { value: solana, label: Solana }
```

Selecting `Base` injects `chain="base"` into every selector in the spec, including the per-provider `regions:` subqueries. URLs are shareable via `?chain=base`.

## Editorial conventions

- **No pre-determined winners.** Specs do not declare a "best" provider. The leader on every page is computed at render time from the lowest p50.
- **Tail before mean.** Headlines use p50 and p99. The arithmetic mean is reported in the table but never used as a takeaway.
- **State the timeout.** Failures are excluded from latency aggregates and counted toward success rate. Both numbers are reported.
- **Methodology first.** A spec without a written methodology is rejected.
- **Corrections in place.** If a number is wrong we publish a dated note on the affected report; future readers see it on the masthead.

## Stack

- Next.js 16 (App Router, ISR, Turbopack) on Vercel
- Tailwind v4 (CSS-only theme, `@theme` tokens) with `@custom-variant dark` class strategy
- Light + dark mode, localStorage-persisted with a pre-paint inline script to avoid flash
- Inter / Inter Tight / JetBrains Mono via `next/font` (Source Serif 4 still loaded for the server-rendered share cards)
- Zod for spec validation
- Prometheus HTTP API (instant + range queries)
- Go 1.24 for the existing harnesses (any language is acceptable)
- WebSockets + a small Go relay for the live dashboard

### Design system

White paper, slate ink ramp, vivid orange accent (`#EA580C`). All chrome
colors are CSS variables in `src/app/globals.css`, with a `.dark` block
that overrides each token for dark mode. Components reference tokens
(`text-ink`, `bg-surface`, `border-rule`, …) instead of literal hex so
the theme switch is purely declarative. Brand colors per chain/product
live in `src/lib/brand.ts` — picked to be saturated enough to read on
both light and dark backgrounds.

Exported share-cards (`/benchmarks/[slug]/share-card`) mirror the active
site theme by reading `html.dark` and appending `?theme=dark` to the
PNG URL — the downloaded image matches what the user is looking at.

## Community

- 💡 [Discussions → Ideas](https://github.com/ChainBench/OpenChainBench/discussions/categories/ideas). brainstorm new benchmarks before writing them up
- 🙋 [Discussions → Q&A](https://github.com/ChainBench/OpenChainBench/discussions/categories/q-a). methodology / harness / spec questions
- 📊 [Discussions → Show & tell](https://github.com/ChainBench/OpenChainBench/discussions/categories/show-and-tell). share forks and dashboards
- 🗺️ [Roadmap](https://github.com/orgs/OpenChainBench/projects). what's planned and what's live
- 🐞 [New issue](https://github.com/ChainBench/OpenChainBench/issues/new/choose). formal benchmark proposal, data-quality flag, or provider correction
- See [SUPPORT.md](./.github/SUPPORT.md) for the full triage matrix.

## SEO TODOs

Tracking the work to make benchmark pages rank for the queries they target.

- **Auto-crawl ping on data update.** Today Google decides when to re-crawl on its own (often 1-2 weeks for a young domain). Build a Vercel cron that:
  - POSTs to [IndexNow](https://www.indexnow.org/) (Bing, Yandex, others) with the changed URLs each day → free, no auth
  - Re-submits `sitemap.xml` to Search Console via the official URL Inspection or Indexing API
  - Why: even though our HTML is regenerated every 60 s via ISR, search snippets keep showing the timestamp Google last crawled. Faster re-crawl = fresher SERP snippet = higher CTR on freshness-sensitive queries ("fastest crypto data API today"). Side benefit: new pages (`/alternatives/*`, new benches) get indexed in 24-48 h instead of weeks.
- **FAQ JSON-LD on /benchmarks/[slug].** Add a `FAQPage` block with 3-5 Q&As per bench ("Which provider is fastest on X?"). Rich snippet in Google + extra keyword density.
- **Keyword densification on high-competition benches** (aggregator-head-lag, bridge-fee). Currently the title contains the target keyword once. Etoffer subtitle + abstract to repeat naturally 2-3×, plus a `headlineSentence()` tweak so the snippet contains the keyword.
- **Internal linking with descriptive anchors.** Ledger-table now links provider names to `/products/[slug]` but with the provider name as anchor. Add cross-references between related benches with anchors like "fastest data provider API" pointing to the relevant /benchmarks/[slug].
- **Headline sentence formatter bug.** Output currently concatenates samples + provider count without separator (e.g. `522,88211 providers`). Split with `·` for readability and Google snippet quality.

## Links

- Site. [openchainbench.com](https://openchainbench.com)
- Live stream. folded into [openchainbench.com](https://openchainbench.com)
- Twitter. [@OpenChainBench](https://x.com/OpenChainBench)
- GitHub. [ChainBench/OpenChainBench](https://github.com/ChainBench/OpenChainBench)

## License

Code: [MIT](./LICENSE).
Reports & figures: [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
