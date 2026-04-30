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
├── aggregator-head-lag/    Go service: WebSocket monitor for indexation lag
├── bridge-quote/           Go service: 4-bridge quote latency + fees
├── bridge-fee/             Go service: cost-percent comparison
└── README.md               Contract for new harnesses

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
[harness] ──── push metrics ────▶ [Prometheus]
   ▲                                    │
   │                                    │ PromQL queries
   │ runs 24/7 on Railway               │ (defined in YAML)
   │                                    ▼
   │                              [benchmarks/<slug>.yml]
   │                                    │
   │                                    │ resolved server-side
   │                                    │ at request time
   │                                    ▼
   │                              [Next.js site] ── ISR 60s
   │                                    │
   │                                    ▼
   │                          openchainbench.xyz/benchmarks/<slug>
   └──── source code lives in harnesses/<slug>/, deployed from this repo
```

The harness is the source of truth: it calls real provider endpoints, measures latency / cost / success, and pushes Prometheus metrics with the labels declared in the spec. The site never fakes numbers — if the harness stops emitting, the affected percentiles disappear from the page rather than fall back to placeholders.

## Architecture

| Layer | Where it runs | Why |
|---|---|---|
| Site (Next.js, ISR) | Vercel | Static pages with 60s revalidate, edge cache |
| Prometheus | Railway | Time-series DB, 24/7 |
| Harnesses (Go) | Railway | Long-running WebSockets, schedulers, on-chain signing |

Vercel and Railway are intentionally split: Vercel can't host long-lived WebSocket connections or sign on-chain transactions; Railway can't serve a globally cached Next.js site at the same cost. They communicate over HTTPS — the site queries Prom URLs declared in each YAML spec.

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

Each harness has its own README with run instructions. They are independent Go programs (one per benchmark) that you can build with `go run ./cmd/...` or via the included Dockerfile.

```bash
cd harnesses/aggregator-head-lag
cp .env.example .env       # fill in API keys
docker-compose up -d       # local Prom + monitor + Grafana
```

Set `prom_url` in the corresponding YAML to your local Prom (`http://localhost:9090`) to render the site against your own data.

## Adding a benchmark

Full guide in [CONTRIBUTING.md](./CONTRIBUTING.md). Short version:

1. **Open an issue** with the [📊 Propose a benchmark template](https://github.com/OpenChainBench/OpenChainBench/issues/new?template=new-benchmark.yml). Sketch the metric, providers, methodology — get feedback before you build. Want to brainstorm first? Use [Discussions → Ideas](https://github.com/OpenChainBench/OpenChainBench/discussions/categories/ideas) instead.
2. **Write the spec** at `benchmarks/<slug>.yml`. Format documented in [`benchmarks/README.md`](./benchmarks/README.md), validated by `src/lib/spec-schema.ts`.
3. **Build the harness** in `harnesses/<slug>/`. Any language works as long as it pushes Prometheus metrics with the labels your spec references. See the existing harnesses as reference.
4. **Open a PR.** CI runs schema validation, typecheck, lint, and build. Once green and merged: the site picks up the new spec automatically; a maintainer wires the harness into Railway (one-time setup per benchmark).

Hosting trade-off: light harnesses (one HTTP poll loop, no secrets) can be deployed onto the OpenChainBench Railway. Harnesses that hold wallets, sign transactions, or otherwise represent capital must run from infra owned by the contributor — they push metrics to a public Prom endpoint and the site queries it the same way.

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
