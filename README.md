# OpenChainBench

> Open, reproducible benchmarks for crypto infrastructure. aggregators, bridges, RPCs, price feeds. Same metric, same conditions, every provider. Live at [openchainbench.com](https://openchainbench.com).

OpenChainBench publishes one benchmark at a time, each one shipping with the script that produces its data. The goal is to make performance an observable property of crypto infra. measured in the open, by anyone who wants to add a provider or a metric.

The project is community-run, MIT-licensed, and accepts PRs from any party including the providers it benchmarks.

## What's inside

```
benchmarks/                 Spec files. one YAML per published benchmark
├── aggregator-head-lag.yml     №001 · onchain data provider latency
├── bridge-quote-latency.yml    №002 · cross-chain bridge quote latency
├── bridge-fee.yml              №003 · cross-chain bridge effective fee
├── metadata-coverage.yml       №004 · token metadata coverage
├── network-coverage.yml        №005 · networks supported (count)
├── perp-fees.yml               №006 · perp DEX taker fees
├── wallet-labels-coverage.yml  №007 · wallet-labels coverage
├── l1-finality.yml             №008 · L1 finality latency
└── README.md                   Spec format reference + submission guide

harnesses/                  The runners that produce the metrics
├── aggregator-head-lag/    Go service: WebSocket monitor (:2112/metrics)
├── bridge-monitor/         Go service: 4-bridge quote loop + execution (:9090/metrics)
├── network-coverage/       Go service: counts each provider's supported networks (:2112/metrics)
├── metadata-coverage/      Go service: per-token metadata coverage probe
├── perp-fees/              Go service: perp-DEX taker fee + funding scrape
├── wallet-labels/          Go service: wallet-labels coverage probe
├── l1-finality/            Go service: per-chain finality latency probe
└── README.md               Contract for new harnesses

alternatives/               YAML-driven /alternatives/<slug> SEO landing pages
└── README.md               Format for "Pump Portal alternatives", "Relay alternatives", …

infrastructure/             Shared services every harness depends on
└── prometheus/             Single shared Prometheus that scrapes all harnesses

src/                        Next.js 16 site (App Router, ISR, Tailwind v4)
├── app/                    Pages. overview, benchmarks index, [slug] reports,
│                           alternatives, /live (real-time stream dashboard)
├── components/             time-series-chart, ledger-table, region-grid, chain-tabs, …
│   └── live/               Live page: dashboard, chart, stats-band, compact-feed, status-bar
├── data/                   Spec loader (YAML → Prometheus → Benchmark[])
└── lib/
    ├── prometheus.ts       Prometheus HTTP client + spec/formatting helpers
    └── live/               Live page domain logic (types, config, chains, format, buckets)
```

The `/live` page is fed by a separate **stream relay** living in the
[`mobula-monorepo`](https://github.com/MobulaFi/mobula-monorepo) at
`miniapps/ocb-stream-relay/`. It is hosted by Mobula because it holds an
upstream API key; the browser talks to it directly over WebSocket. Vercel
only serves the static page shell. See [`docs/architecture.md`](./docs/architecture.md#the-live-page)
for the data flow.

## How a benchmark gets data. federation

OpenChainBench is a federation of independently-hosted harnesses connected by a single shared Prometheus.

```
[Mobula's infra]         [Contributor B's infra]      [Provider C's infra]
   harness exposes          harness exposes               harness exposes
   /metrics on              /metrics on                   /metrics on
   <public HTTPS URL>       <public HTTPS URL>            <public HTTPS URL>
        │                          │                              │
        └──────────────────────────┼──────────────────────────────┘
                                   ▼
                  ┌────────────────────────────────────┐
                  │ OpenChainBench Prometheus          │
                  │ scrapes every harness's URL on a   │
                  │ schedule, 365d retention           │
                  └────────────────┬───────────────────┘
                                   │ HTTPS
                                   │ /api/v1/query
                                   ▼
                          openchainbench.com
                          (Next.js site on Vercel, ISR 60s)
```

Each harness is run by whoever wrote it. Mobula for the existing aggregator and bridge benchmarks, independent contributors for any future ones, providers for self-benchmarks of their own services. They never share API keys with the project. They expose `/metrics` over HTTPS and the OpenChainBench Prometheus scrapes the public URL.

The site queries the shared Prometheus URL declared in each YAML spec via the standard Prometheus HTTP API (`/api/v1/query`, `/api/v1/query_range`). ISR caches the response on Vercel's edge for 60 s.

## The `/live` page

A second data path exists for [openchainbench.com/live](https://openchainbench.com/live): a real-time dashboard of swap events streamed from Mobula's fast-trade WebSocket. The data **does not flow through Prometheus** — it goes directly from the relay's WebSocket to the browser, with the Vercel site acting as a thin static shell.

```
[Mobula fast-trade WS]      [Mobula REST /lighthouse,/all]
        │                              │
        ▼                              ▼
                ocb-stream-relay (Railway)
                 │  - 10min rolling chart buffer
                 │  - 24h vol counter
                 │  - lighthouse poller (5min)
                 │  - mcap poller (10min)
                 │  - snapshot sent on each client connect
                 ▼  wss://ocb-stream-relay-...up.railway.app/ws
                browser (openchainbench.com/live)
                Next.js Client Component, no Vercel relay
```

Single Railway box, in-memory fan-out. Cost stays flat regardless of viewer count. See [`docs/architecture.md`](./docs/architecture.md#the-live-page) for the full diagram.

## Architecture

| Layer | Where it runs | Notes |
|---|---|---|
| Site (Next.js, ISR) | Vercel | Static pages with 60s revalidate, edge cache. Zero secrets. only queries the public Prom URL. |
| Prometheus | A small Railway service | The only piece of shared OpenChainBench infrastructure. Open access (read-only public API). |
| Harnesses | Wherever the contributor wants to host them | Railway, Fly, Cloud Run, a VPS. each contributor owns their own runtime, secrets, and budget. |
| `/live` relay | Mobula's Railway | Holds the Mobula API key, fans out Mobula fast-trade events to browsers. Not in this repo. |

The split is intentional: Vercel for the globally-cached read path, Prometheus for the time-series store, and any compute platform for the long-running data producers. Nobody other than the harness operator needs the harness's secrets.

## Running the site locally

```bash
pnpm install
pnpm dev              # http://localhost:3000
```

The site reads every `benchmarks/*.yml` at request time. Specs whose Prometheus URL the runtime can't reach render as drafts (no numbers, methodology only).

```bash
pnpm validate            # schema-lint every spec in benchmarks/
pnpm spec:dry-run <slug> # query Prometheus and print numbers, no rendering
pnpm build               # production build
```

The `/live` page connects to the production relay by default. To point it at a local relay (see the relay README for instructions), set:

```bash
NEXT_PUBLIC_RELAY_WS_URL=ws://localhost:2112/ws pnpm dev
```

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

1. **Open an issue** with the [📊 Propose a benchmark template](https://github.com/OpenChainBench/OpenChainBench/issues/new?template=new-benchmark.yml). Sketch the metric, providers, methodology. get feedback before you build. Want to brainstorm first? Use [Discussions → Ideas](https://github.com/OpenChainBench/OpenChainBench/discussions/categories/ideas) instead.
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

Selecting `Base` injects `chain="base"` into every selector in the spec — including the per-provider `regions:` subqueries. URLs are shareable via `?chain=base`.

## Editorial conventions

- **No pre-determined winners.** Specs do not declare a "best" provider. The leader on every page is computed at render time from the lowest p50.
- **Tail before mean.** Headlines use p50 and p99. The arithmetic mean is reported in the table but never used as a takeaway.
- **State the timeout.** Failures are excluded from latency aggregates and counted toward success rate. Both numbers are reported.
- **Methodology first.** A spec without a written methodology is rejected.
- **Corrections in place.** If a number is wrong we publish a dated note on the affected report; future readers see it on the masthead.

## Stack

- Next.js 16 (App Router, ISR, Turbopack) on Vercel
- Tailwind v4 (CSS-only theme, `@theme` tokens)
- Source Serif 4 / Inter Tight / JetBrains Mono via `next/font`
- Zod for spec validation
- Prometheus HTTP API (instant + range queries)
- Go 1.24 for the existing harnesses (any language is acceptable)
- WebSockets + a small Go relay for the `/live` page

## Community

- 💡 [Discussions → Ideas](https://github.com/OpenChainBench/OpenChainBench/discussions/categories/ideas). brainstorm new benchmarks before writing them up
- 🙋 [Discussions → Q&A](https://github.com/OpenChainBench/OpenChainBench/discussions/categories/q-a). methodology / harness / spec questions
- 📊 [Discussions → Show & tell](https://github.com/OpenChainBench/OpenChainBench/discussions/categories/show-and-tell). share forks and dashboards
- 🗺️ [Roadmap](https://github.com/orgs/OpenChainBench/projects). what's planned and what's live
- 🐞 [New issue](https://github.com/OpenChainBench/OpenChainBench/issues/new/choose). formal benchmark proposal, data-quality flag, or provider correction
- See [SUPPORT.md](./.github/SUPPORT.md) for the full triage matrix.

## Links

- Site. [openchainbench.com](https://openchainbench.com)
- Live stream. [openchainbench.com/live](https://openchainbench.com/live)
- Twitter. [@openchainbench](https://twitter.com/openchainbench)
- GitHub. [OpenChainBench/OpenChainBench](https://github.com/OpenChainBench/OpenChainBench)

## License

Code: [MIT](./LICENSE).
Reports & figures: [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
