# OpenChainBench

> An open, reproducible benchmark series for crypto infrastructure — aggregators, bridges, price feeds, and more. Live at [openchainbench.xyz](https://openchainbench.xyz).

OpenChainBench is a "field journal" — a research-paper-styled site that publishes one benchmark at a time, each one shipping with the script that produced it. The goal is to make performance an observable property of crypto infra, the way uptime is for SaaS.

The project is **sponsored by [Mobula](https://mobula.io)** and **edited independently**: every provider (sponsor included) goes through the same harness with the same inputs, and corrections are published in the open.

## What's inside

```
src/
├── app/                          Next.js 16 App Router
│   ├── page.tsx                  Front page (Issue 001)
│   ├── benchmarks/
│   │   ├── page.tsx              Index of benchmarks
│   │   └── [slug]/page.tsx       One report per slug
│   ├── methodology/page.tsx
│   ├── about/page.tsx
│   ├── press/page.tsx
│   ├── opengraph-image.tsx       Social card
│   ├── icon.tsx                  Favicon
│   └── globals.css               Paper theme
├── components/
│   ├── site-header.tsx           Masthead + nav
│   ├── site-footer.tsx
│   ├── byline.tsx                Bench №, last-run, n=
│   ├── paper-bar-chart.tsx       Tufte-style bars
│   ├── stat-table.tsx            p50/p90/p99/mean/success
│   └── section-rule.tsx
├── data/
│   ├── benchmarks.ts             Mock data (swap for live)
│   └── site.ts                   Site constants
└── lib/
    └── utils.ts
```

Tailwind v4 with a paper aesthetic — cream background, Source Serif 4 for body, Inter for UI labels, JetBrains Mono for figures.

## Running locally

```bash
pnpm install
pnpm dev
```

Open [localhost:3000](http://localhost:3000).

## Adding a benchmark

1. Append a new entry to `src/data/benchmarks.ts` with a unique `slug` and `number`.
2. Drop your harness into `harnesses/<your-bench>/` (TypeScript, Bun or Python — whatever fits the providers being measured).
3. Wire the harness output into the dataset (a build step writes to `data/benchmarks.ts` from the harness JSON output).
4. Open a PR. The methodology + numbers go live with the merge.

The shape of a benchmark report is fixed: abstract → results chart → stat table → findings → methodology → citation block. Don't drift; readers learn the format and skim by it.

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
