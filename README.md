# OpenChainBench

> Open, reproducible benchmarks for crypto infrastructure — aggregators, bridges, RPCs, price feeds. Same metric, same conditions, every provider. Live at [openchainbench.xyz](https://openchainbench.xyz).

OpenChainBench publishes one benchmark at a time, each one shipping with the script that produces its data. The goal is to make performance an observable property of crypto infra — measured in the open, by anyone who wants to add a provider or a metric.

The project is community-run, MIT-licensed, and accepts PRs from any party including the providers it benchmarks.

## What's inside

```
benchmarks/                 Spec files — one YAML per published benchmark
├── aggregator-head-lag.yml
├── bridge-quote-latency.yml
├── bridge-fee.yml
└── README.md               Spec format reference + submission guide

harnesses/                  The runners that produce the metrics
├── aggregator-head-lag/    Go service: WebSocket monitor (exposes :2112/metrics)
├── bridge-monitor/         Go service: 4-bridge quote loop + execution (:9090/metrics)
└── README.md               Contract for new harnesses

infrastructure/             Shared services every harness depends on
└── prometheus/             Single shared Prometheus that scrapes all harnesses

src/                        Next.js 16 site (App Router, ISR, Tailwind v4)
├── app/                    Pages — overview, benchmarks index, [slug] reports
├── components/             time-series-chart, ledger-table, region-grid, …
├── data/                   Spec loader (YAML → Prometheus → Benchmark[])
└── lib/                    Prometheus client, spec schema (Zod), formatting

scripts/                    pnpm validate, pnpm spec:dry-run
docs/                       Methodology, ADRs, style guide
```

## How a benchmark gets data

```
                          Railway (OpenChainBench project)
   ┌───────────────────────────────────────────────────────────┐
   │                                                           │
   │  harnesses/aggregator-head-lag → :2112/metrics ─┐         │
   │  harnesses/bridge-monitor      → :9090/metrics ─┼─▶ prometheus
   │  harnesses/<future>            → :????/metrics ─┘   (scrape every 15s,
   │                                                      365d retention)
   └────────────────────────────────────────┬──────────────────┘
                                            │ HTTPS public URL
                                            │ /api/v1/query
                                            ▼
                                  ┌─────────────────────┐
                                  │  Next.js site       │
                                  │  on Vercel          │
                                  │  ISR 60s            │
                                  └──────────┬──────────┘
                                             │
                                             ▼
                              openchainbench.xyz/benchmarks/<slug>
```

The harnesses are data producers — they call real provider endpoints, measure latency / cost / success, and expose Prometheus metrics on `/metrics`. A single shared Prometheus scrapes every harness over Railway's internal DNS and aggregates everything into one queryable instance. The Next.js site queries that single Prometheus URL declared in each YAML spec via the standard Prometheus HTTP API (`/api/v1/query` and `/api/v1/query_range`); ISR caches the response on Vercel's edge for 60 s.

## Architecture

| Layer | Where it runs | Why |
|---|---|---|
| Site (Next.js, ISR) | Vercel | Static pages with 60s revalidate, edge cache |
| Prometheus | Railway | Single shared instance scraping every harness |
| Harnesses (Go) | Railway | Long-running WebSockets, schedulers, on-chain signing |

Vercel and Railway are intentionally split: Vercel can't host long-lived WebSocket connections or sign on-chain transactions; Railway can't serve a globally cached Next.js site at the same cost. They communicate over HTTPS — the site queries the shared Prometheus URL declared in each YAML spec.

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

## Running a harness locally

Each harness is a standalone Go binary that exposes `/metrics` on a documented port (`:2112` for aggregator, `:9090` for bridge). They have no Prometheus / Grafana dependencies — that lives in [`infrastructure/`](./infrastructure/) and is shared.

```bash
cd harnesses/aggregator-head-lag
cp .env.example .env       # fill in API keys
go run ./cmd/script/       # or: docker build -t hh . && docker run -p 2112:2112 hh
```

To render the site against your local harness, run a local Prometheus scraping `localhost:<port>` (the [`infrastructure/prometheus/README.md`](./infrastructure/prometheus/README.md) has notes) and point the corresponding YAML's `prom_url` at it.

## Adding a benchmark

Full guide in [CONTRIBUTING.md](./CONTRIBUTING.md). Short version:

1. **Open an issue** with the [📊 Propose a benchmark template](https://github.com/OpenChainBench/OpenChainBench/issues/new?template=new-benchmark.yml). Sketch the metric, providers, methodology — get feedback before you build. Want to brainstorm first? Use [Discussions → Ideas](https://github.com/OpenChainBench/OpenChainBench/discussions/categories/ideas) instead.
2. **Write the spec** at `benchmarks/<slug>.yml`. Format documented in [`benchmarks/README.md`](./benchmarks/README.md), validated by `src/lib/spec-schema.ts`.
3. **Build the harness** in `harnesses/<slug>/`. Any language works as long as it exposes `/metrics` over HTTP with the metric names and labels your spec references. The harness is a data producer only — no Prometheus, Grafana, or Alertmanager packaging.
4. **Add a scrape entry** to `infrastructure/prometheus/prometheus.yml` so the shared Prometheus picks up your harness.
5. **Open a PR.** CI runs schema validation, typecheck, lint, and build. Once merged: the site picks up the new spec automatically; a maintainer creates the Railway service for the harness and redeploys Prometheus to apply the new scrape job.

Hosting trade-off: light harnesses (one HTTP poll loop, no secrets) are deployed onto the OpenChainBench Railway. Harnesses that hold wallets, sign transactions, or otherwise represent capital are hosted by the contributor — they expose `/metrics` on a publicly-reachable URL and the central Prometheus scrapes it the same way as project-hosted harnesses.

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

## Community

- 💡 [Discussions → Ideas](https://github.com/OpenChainBench/OpenChainBench/discussions/categories/ideas) — brainstorm new benchmarks before writing them up
- 🙋 [Discussions → Q&A](https://github.com/OpenChainBench/OpenChainBench/discussions/categories/q-a) — methodology / harness / spec questions
- 📊 [Discussions → Show & tell](https://github.com/OpenChainBench/OpenChainBench/discussions/categories/show-and-tell) — share forks and dashboards
- 🗺️ [Roadmap](https://github.com/orgs/OpenChainBench/projects) — what's planned and what's live
- 🐞 [New issue](https://github.com/OpenChainBench/OpenChainBench/issues/new/choose) — formal benchmark proposal, data-quality flag, or provider correction
- See [SUPPORT.md](./.github/SUPPORT.md) for the full triage matrix.

## Links

- Site — [openchainbench.xyz](https://openchainbench.xyz)
- Twitter — [@openchainbench](https://twitter.com/openchainbench)
- GitHub — [OpenChainBench/OpenChainBench](https://github.com/OpenChainBench/OpenChainBench)

## License

Code: [MIT](./LICENSE).
Reports & figures: [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
