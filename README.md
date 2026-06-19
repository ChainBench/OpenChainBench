# OpenChainBench

> Open, reproducible benchmarks for crypto infrastructure. aggregators, bridges, RPCs, price feeds. Same metric, same conditions, every provider. Live at [openchainbench.com](https://openchainbench.com).

OpenChainBench publishes one benchmark at a time, each one shipping with the script that produces its data. The goal is to make performance an observable property of crypto infra. measured in the open, by anyone who wants to add a provider or a metric.

The project is community-run, MIT-licensed, and accepts PRs from any party including the providers it benchmarks.

Staging (auto-deployed from `dev`): [Vercel Preview](https://github.com/ChainBench/OpenChainBench/actions/workflows/staging-deploy.yml). Production: [openchainbench.com](https://openchainbench.com). Source: [ChainBench/OpenChainBench](https://github.com/ChainBench/OpenChainBench).

## What's inside

```
benchmarks/                 Spec files. one YAML per published benchmark (30+)
├── aggregator-head-lag.yml     №001 · onchain data provider latency
├── bridge-quote-latency.yml    №002 · cross-chain bridge quote latency
├── hyperliquid-frontends.yml   №030 · HL builder-code revenue (100+ frontends)
├── perp-funding.yml            №036 · perp funding rates across venues
├── pm-rate-limits.yml          №037 · prediction-market API rate limits
├── …                           (run `ls benchmarks/` for the full list)
└── README.md                   Spec format reference + submission guide

harnesses/                  Open-source runners that produce the metrics
├── aggregator-head-lag/    Go service, exposes :2112/metrics
├── bridge-monitor/         Go service, exposes :9090/metrics
├── hyperliquid-frontends/  Go service: tails a local hl-node fill stream;
│                           feeds benches №030/№036 + HIP-3 deployers,
│                           builder registry in builders.json (100+ entries)
├── l1-finality/            Go service: per-chain finality latency probe
├── …                       (oracle-deviation, solana-tx-landing, validator-yield, …)
└── README.md               Contract for new harnesses

worker/index.ts             Materialization worker (Railway): sweeps every bench
                            against Prometheus every 60s, publishes snapshots
                            to the Redis store the site reads

alternatives/               YAML-driven /alternatives/<slug> SEO landing pages
└── README.md               Format for "Pump Portal alternatives", "Relay alternatives", …

infrastructure/             Shared services every harness depends on
└── prometheus/             Single shared Prometheus that scrapes all harnesses

src/                        Next.js 16 site (App Router, ISR, Tailwind v4)
├── app/                    Pages:
│                             /             — hero with animated radar dial, live
│                                             Network Ecosystem, Latest deployed
│                                             benchmarks table
│                             /benchmarks   — card grid with category pill filter
│                                             + search
│                             /products     — "Products" list with brand logos,
│                                             benchmark / Top-1 counts
│                             /contribute   — 6-step tutorial + federation /
│                                             timeline cards
│                             /methodology  — design principles + statistical
│                                             conventions
│                             /benchmarks/[slug] — bench detail with card-wrapped
│                                             chart + ledger
│                             /alternatives, /press, /mcp, /about, /chains,
│                             /compare, /partners
├── components/             Server-first, with thin client islands. Includes
│                           shared primitives (back-link, page-hero) and
│                           live/ subdir for the live dashboard.
├── data/
│   ├── benchmarks.ts        Async loader (YAML + materialized snapshots →
│   │                        Benchmark[])
│   └── provider-registry.ts Per-provider description, URL, Twitter handle
└── lib/
    ├── prometheus.ts        Prometheus HTTP client + spec/formatting helpers
    ├── spec.ts              YAML loader, snapshot read path, live-Prom fallback
    ├── spec-schema.ts       Zod schema (single source of truth)
    ├── providers.ts         Aggregates each provider's benchmark appearances
    ├── brand.ts             Vivid brand-color table per chain / provider
    ├── time-constants.ts    Single source of truth for MS_PER_* /
    │                        SECONDS_PER_* durations
    ├── live/                Live page domain logic (types, config, chains,
    │                        format, buckets)
    └── materialize/         Worker-shared materialization layer (see below)
        ├── filters.ts       Snapshot acceptance / freshness gates
        ├── prom-queries.ts  Per-bench Prom query builders
        ├── editorial.ts     Headline sentence + copy assembly
        ├── cell-ranks.ts    Cross-snapshot rank/value diff
        ├── load.ts          Snapshot loader (KV → fallback)
        ├── schema.ts        Snapshot wire shape (Zod)
        └── store.ts         KV store I/O (Upstash / ioredis)
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
| [`/rss.xml`](https://openchainbench.com/rss.xml) | Newsreaders, planet feeds | RSS feed of benchmark releases. |

Each bench detail page also has a **Copy API URL** strip under the title. one click and a journalist has the JSON endpoint for live numbers.

### How agents query us

**Via MCP (recommended)**: OpenChainBench ships an MCP server at `https://openchainbench.com/api/mcp/mcp` (Streamable HTTP transport, no auth). Any MCP-capable client (Claude Desktop, Cursor, ChatGPT custom tools, generic MCP clients) can connect and discover:

- **3 tools**: `list_benchmarks`, `get_benchmark(slug, chain?, region?)`, `query_prom(query, windowSec?, steps?)` — `query_prom` is scoped to the published benchmark metric namespaces so the public endpoint can't be used to walk the underlying Prometheus catalog.
- **1 resource template**: `openchainbench://benchmark/{slug}` — every live benchmark is also exposed as an MCP resource (Markdown + JSON).

**Via REST**: hit `/api/citable` once to discover everything, then `/api/stat/<slug>` for specifics. Both are zero-auth, edge-cached for 60 s.

## Architecture in one minute

```
benchmarks/<slug>.yml ──► worker/index.ts ──► Redis snapshot store ──► Next.js (ISR) ──► reader
                          (Railway, 60s)       (Upstash)                 (Vercel)
                                  ▲
                                  │
                       Prometheus (Railway) ◄─── harnesses on contributor infra
```

| Layer | Where it runs | Notes |
|---|---|---|
| Site (Next.js 16, ISR) | Vercel | Bench detail pages on `revalidate: 60`, static hubs. Reads materialized snapshots (`READ_FROM_STORE=1`) with a live-Prom fallback. |
| Materialization worker | Railway (`ocb-materialize-worker`) | Runs `worker/index.ts` via tsx. Sweeps every bench against Prometheus every 60 s, applies per-provider carry-forward, publishes atomic snapshots to KV. The image clones OCB `dev` at build — rebuild it after spec provider-list changes. |
| Snapshot store | Upstash Redis (Vercel Marketplace) | Atomic per-(bench, variant) snapshot blobs + heartbeat key. |
| Prometheus | Railway service | Shared OpenChainBench time-series store. Open read-only public API. |
| Harnesses | Wherever the contributor wants to host them | Railway, Fly, Cloud Run, a VPS. Each contributor owns their own runtime, secrets, and budget. |
| Live-stream relay | Mobula's Railway | Holds the Mobula API key, fans out fast-trade events to browsers. Source: `miniapps/ocb-stream-relay/` in `mobula-monorepo`. |

Resilience layers, from inside out:

1. **Carry-forward in the worker.** Transient per-provider query failures keep their last good value with a `staleSince` timestamp instead of producing leaderboard holes.
2. **Snapshot freshness gate with live fallback.** If a snapshot is missing or older than the acceptance window, the site falls back to the original live-Prometheus loader.
3. **Per-bench `unstable_cache` revalidate 60 s + ISR** on top of the store read.
4. **Vercel edge cache** (`s-maxage` + `stale-while-revalidate`) on every public route.

Full diagrams and module boundaries in [`docs/architecture.md`](./docs/architecture.md).

### The materialize layer

The materialization read/write pipeline lives at [`src/lib/materialize/`](./src/lib/materialize/) and is shared between `worker/index.ts` and the request-time loader in `src/lib/spec.ts`. Files are colocated by responsibility:

- `filters.ts` — snapshot acceptance windows, per-provider freshness gates.
- `prom-queries.ts` — per-bench Prom query builders, dimension injection.
- `editorial.ts` — headline sentence + paste-ready quote assembly.
- `cell-ranks.ts` — cross-snapshot rank/value diff used by leader badges.
- `load.ts` — snapshot loader (KV → live-Prom fallback).
- `schema.ts` — snapshot wire shape (Zod).
- `store.ts` — KV I/O (Upstash REST + ioredis).

Each file ships with a colocated `*.test.ts` (Bun's `bun:test`).

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
pnpm typecheck           # tsc --noEmit
pnpm lint                # eslint
pnpm check               # validate + typecheck + lint + test (pre-PR gate)
pnpm build               # production build (Turbopack)
pnpm worker              # run the materialization worker locally
```

Tests run under [Bun](https://bun.sh) (`bun test src/`); everything else uses pnpm + Node. The lockfile is `pnpm-lock.yaml`.

To point the live dashboard at a local stream relay (see the relay README in `mobula-monorepo`):

```bash
NEXT_PUBLIC_RELAY_WS_URL=ws://localhost:2112/ws pnpm dev
```

For production deployments, attaching an Upstash Redis via the Vercel Marketplace is recommended. Once connected, `KV_REST_API_URL` and `KV_REST_API_TOKEN` are injected automatically and the snapshot fallback activates. Without them the site behaves identically to a deployment without KV: a cold-start hit during a Prom blackout will fall through to a draft placeholder until the next successful scrape lands.

## Running a harness locally

Each harness is a standalone binary (most are Go) that exposes `/metrics` on a documented port (`:2112` for aggregator, `:9090` for bridge). They have no Prometheus / Grafana dependencies. that lives in [`infrastructure/`](./infrastructure/) and is shared.

```bash
cd harnesses/aggregator-head-lag
cp .env.example .env       # fill in API keys
go run ./cmd/script/       # or: docker build -t hh . && docker run -p 2112:2112 hh
```

To render the site against your local harness, run a local Prometheus scraping `localhost:<port>` (the [`infrastructure/prometheus/README.md`](./infrastructure/prometheus/README.md) has notes) and point the corresponding YAML's `prometheus.url` at it.

## Adding a benchmark

Full guide in [CONTRIBUTING.md](./CONTRIBUTING.md). Contributor walkthrough at [`/contribute`](https://openchainbench.com/contribute). Concrete end-to-end worked example in [`docs/walkthrough.md`](./docs/walkthrough.md). Short version:

1. **Open an issue** with the [Propose a benchmark template](https://github.com/ChainBench/OpenChainBench/issues/new?template=new-benchmark.yml). Sketch the metric, providers, methodology. get feedback before you build.
2. **Write the spec** at `benchmarks/<slug>.yml`. Format documented in [`benchmarks/README.md`](./benchmarks/README.md), validated by `src/lib/spec-schema.ts`.
3. **Build the harness** in `harnesses/<slug>/`. Any language as long as it exposes `/metrics` over HTTPS.
4. **Deploy the harness** on whatever infra fits. You own the runtime, the secrets, the budget.
5. **Add a scrape entry** to `infrastructure/prometheus/prometheus.yml` pointing at your public URL.
6. **Open a PR against `dev`.** CI runs schema validation, typecheck, lint, build, tests. Once merged a maintainer redeploys Prometheus and rebuilds the worker; the site renders the new bench on the next sweep + ISR cycle (≤ 2 min).

You never share API keys or wallet keys with the project. Your harness runs with your credentials, on your infra, on your budget. the maintainers only see the metric values your harness chooses to publish.

## Branch workflow

Two long-lived branches: `dev` (staging) and `main` (production). Feature branches PR to `dev`; production releases ship via a `dev → main` PR. Full rules and the hotfix path are in [`AGENTS.md`](./AGENTS.md).

Staging emits `<meta robots=noindex>` and serves `robots.txt: Disallow /` so the Vercel Preview URL doesn't double up against the prod domain.

## Editorial conventions

- **No pre-determined winners.** Specs do not declare a "best" provider. The leader on every page is computed at render time from the lowest p50.
- **Tail before mean.** Headlines use p50 and p99. The arithmetic mean is reported in the table but never used as a takeaway.
- **State the timeout.** Failures are excluded from latency aggregates and counted toward success rate. Both numbers are reported.
- **Methodology first.** A spec without a written methodology is rejected.
- **Corrections in place.** If a number is wrong we publish a dated note on the affected report; future readers see it on the masthead.

## Stack

- Next.js 16 (App Router, ISR, Turbopack) on Vercel
- React 19, Tailwind v4 (CSS-only theme, `@theme` tokens) with `@custom-variant dark` class strategy
- Light + dark mode, localStorage-persisted with a pre-paint inline script to avoid flash
- Inter / Inter Tight / JetBrains Mono via `next/font` (Source Serif 4 still loaded for server-rendered share cards)
- Zod for spec validation
- Prometheus HTTP API (instant + range queries)
- Upstash Redis (via Vercel Marketplace) for snapshot store; `ioredis` for the worker, REST for serverless
- `tsx` for `worker/` and the validation/dry-run scripts
- Bun for tests (`bun test src/`); pnpm for everything else
- `@modelcontextprotocol/sdk` + `mcp-handler` for the MCP server
- Go 1.24 for the existing harnesses (any language is acceptable)

### Design system

White paper, slate ink ramp, vivid orange accent (`#EA580C`). All chrome
colors are CSS variables in `src/app/globals.css`, with a `.dark` block
that overrides each token for dark mode. Components reference tokens
(`text-ink`, `bg-surface`, `border-rule`, …) instead of literal hex so
the theme switch is purely declarative. Brand colors per chain/product
live in `src/lib/brand.ts`.

## Community

- [Discussions → Ideas](https://github.com/ChainBench/OpenChainBench/discussions/categories/ideas). brainstorm new benchmarks before writing them up
- [Discussions → Q&A](https://github.com/ChainBench/OpenChainBench/discussions/categories/q-a). methodology / harness / spec questions
- [Discussions → Show & tell](https://github.com/ChainBench/OpenChainBench/discussions/categories/show-and-tell). share forks and dashboards
- [Roadmap](https://github.com/orgs/OpenChainBench/projects). what's planned and what's live
- [New issue](https://github.com/ChainBench/OpenChainBench/issues/new/choose). formal benchmark proposal, data-quality flag, or provider correction
- See [SUPPORT.md](./.github/SUPPORT.md) for the full triage matrix.

## Links

- Site. [openchainbench.com](https://openchainbench.com)
- Twitter. [@OpenChainBench](https://x.com/OpenChainBench)
- GitHub. [ChainBench/OpenChainBench](https://github.com/ChainBench/OpenChainBench)
- RSS. [openchainbench.com/rss.xml](https://openchainbench.com/rss.xml)

## License

Code: [MIT](./LICENSE).
Reports & figures: [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
