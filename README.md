# OpenChainBench

> An open, reproducible benchmark series for crypto infrastructure — aggregators, bridges, price feeds, and more. Live at [openchainbench.xyz](https://openchainbench.xyz).

OpenChainBench is a "field journal" — a research-paper-styled site that publishes one benchmark at a time, each one shipping with the script that produced it. The goal is to make performance an observable property of crypto infra, the way uptime is for SaaS.

The project is **sponsored by [Mobula](https://mobula.io)** and **edited independently**: every provider (sponsor included) goes through the same harness with the same inputs, and corrections are published in the open.

## What's inside

```
benchmarks/                       Spec files — one YAML per report
├── README.md                     Spec reference + submission guide
└── *.yml                         A spec wires editorial metadata to PromQL
src/
├── app/                          Next.js 16 App Router
│   ├── page.tsx                  Front page
│   ├── benchmarks/
│   │   ├── page.tsx              Index
│   │   └── [slug]/page.tsx       One paper-styled report per slug
│   ├── methodology / about / press / opengraph-image / icon
│   └── globals.css               Paper theme
├── components/
│   ├── site-header / site-footer
│   ├── byline · big-number · section-rule · figure
│   ├── range-chart               Editorial range plot (p50→p99 + median)
│   ├── ledger-table              Stock-exchange-style table w/ sparklines
│   ├── region-grid               Tufte small multiples per region
│   └── sparkline                 24h trend SVG
├── data/
│   ├── benchmarks.ts             Mock data + async loaders
│   └── site.ts                   Site constants
└── lib/
    ├── prometheus.ts             HTTP API client (instant + range queries)
    ├── spec.ts                   YAML loader, overlay-live-on-mock policy
    └── format.ts / utils.ts
```

Tailwind v4 with a paper aesthetic — cream background, Source Serif 4 for body, Inter for UI labels, JetBrains Mono for figures.

## Running locally

```bash
pnpm install
pnpm dev
```

Open [localhost:3000](http://localhost:3000).

## How a benchmark gets data

```
benchmarks/<slug>.yml ── PromQL ──► Prometheus
        │                                │
        │ (fail / empty / no URL)        │ (live numbers)
        ▼                                ▼
src/data/benchmarks.ts (mock fallback) ─►  Benchmark[]
                                              │
                                              ▼
                                Paper report at /benchmarks/<slug>
```

Pages revalidate every minute (Next.js ISR). Live numbers replace mock numbers as soon as the harness starts emitting metrics with the labels the spec expects. The site never half-renders: any missing percentile and the page falls back to the mock so readers can't be misled about what's real.

## Adding a benchmark

1. **Editorial mock.** Append an entry to `MOCK_BENCHMARKS` in `src/data/benchmarks.ts` with title, abstract, methodology, findings and placeholder numbers per provider. This is what readers see until the harness fills Prometheus.
2. **Harness.** Drop the script that emits metrics into `harnesses/<slug>/` (TypeScript, Bun or Python — whatever fits). The harness runs continuously and pushes to Prometheus / writes to a Pushgateway.
3. **Spec.** Create `benchmarks/<slug>.yml` with the Prometheus URL and the PromQL queries (see `benchmarks/aggregator-quote-latency.yml`).
4. **PR.** The build picks the spec up automatically.

The shape of a benchmark report is fixed: abstract → range chart → ledger table → region grid → findings → methodology → citation. Don't drift; readers learn the format and skim by it.

## Data provenance

Each report links its harness in the source line. Every run stores raw transcripts (request + response, timestamps, region) so any single data point can be audited after the fact. If a number is wrong we publish a dated correction in place; future issues acknowledge it on the masthead.

## Editorial policy

- Mobula does not see results before publication and cannot block a report.
- The benchmark plan (providers, routes, cadence, timeout) is committed before each run.
- Where Mobula loses, we publish that. Where it wins, we explain why.
- All code is MIT, all reports are CC-BY-4.0.

## Stack

- Next.js 16 (App Router) on Vercel
- Tailwind v4 (CSS-only theme)
- Source Serif 4 / Inter / JetBrains Mono via `next/font`
- Static rendering — every benchmark page is pre-rendered, with ISR for live runs once the harness is wired in.

## Social

- Twitter / X — [@openchainbench](https://twitter.com/openchainbench)
- Reddit — [r/openchainbench](https://reddit.com/r/openchainbench)
- GitHub — [mobula/openchainbench](https://github.com/mobula/openchainbench)

## License

Code: [MIT](./LICENSE).
Reports & figures: [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
