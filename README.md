# OpenChainBench

> Open, reproducible benchmarks for crypto infrastructure. Aggregators, bridges, RPCs, oracles, price feeds, prediction markets, perp DEXes, cross-chain messaging. Same metric, same conditions, every provider. Live at **[openchainbench.com](https://openchainbench.com)**.

[![License: MIT](https://img.shields.io/badge/code-MIT-blue.svg)](./LICENSE) [![Data: CC-BY-4.0](https://img.shields.io/badge/data-CC--BY--4.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/) [![Benchmarks](https://img.shields.io/badge/benchmarks-94_live-green.svg)](https://openchainbench.com/benchmarks) [![MCP](https://img.shields.io/badge/MCP-ready-purple.svg)](https://openchainbench.com/mcp) [![llms.txt](https://img.shields.io/badge/llms.txt-yes-orange.svg)](https://openchainbench.com/llms.txt)

OpenChainBench publishes one benchmark at a time, each shipping with the harness that produces its data. The goal is to make performance an observable property of crypto infra — measured in the open, by anyone who wants to add a provider or a metric.

Community-run, MIT-licensed harnesses + CC-BY-4.0 data, PRs from any party including the providers we benchmark.

## At a glance

- **94** live benchmark specs across 8 categories (RPCs, Trading, Aggregators, Bridges, Blockchains, RWA, Explorers, NFT APIs)
- **50** self-contained Go harnesses, each shipping a `/metrics` Prometheus endpoint
- **32** curated question/answer pages · **23** "alternatives to X" landing pages
- **26** machine-readable API routes (citation, badges, MCP, feeds, per-format quotes)
- One shared Prometheus, one materialization worker, CDN-fastpath snapshot store — cold reads in < 100 ms edge, no origin fan-out on hot paths

## Quickstart

```bash
pnpm install
pnpm dev              # site at http://localhost:3000
pnpm validate         # bench spec Zod schema check (run before opening a PR)
pnpm typecheck        # tsc --noEmit
```

Adding a benchmark, writing a harness, or fixing a number: see [CONTRIBUTING.md](./CONTRIBUTING.md) + the visual walkthrough at [`/contribute`](https://openchainbench.com/contribute).

## Machine-readable surfaces

Every benchmark is licensed CC-BY-4.0 and exposed through endpoints designed for citation by journalists, devs, and AI agents:

| Endpoint | Audience | What it returns |
|---|---|---|
| [`/llms.txt`](https://openchainbench.com/llms.txt) · [`/llms-full.txt`](https://openchainbench.com/llms-full.txt) | LLM crawlers | Plain-text index (short) + full Markdown context (long) per the [llmstxt.org](https://llmstxt.org) convention. |
| [`/api/citable`](https://openchainbench.com/api/citable) | Devs, agents | Flat JSON: every benchmark with current value, leader, headline sentence, citation URL, OG image URL. |
| [`/api/stat/<slug>`](https://openchainbench.com/api/stat/aggregator-head-lag) | Devs, agents | Single benchmark: full rankings, sparkline (24h), methodology, paste-ready quote, attribution URL. |
| `/api/cite/<slug>/<format>` | Zotero, Mendeley, Perplexity | Citation in `bibtex`, `apa`, `ris`, or `txt` with the correct MIME type. |
| [`/api/openapi.json`](https://openchainbench.com/api/openapi.json) | LangChain, custom GPTs, generic clients | OpenAPI 3.1 schema describing every endpoint. |
| [`/api/mcp/mcp`](https://openchainbench.com/api/mcp/mcp) | MCP clients (Claude Desktop, Cursor, ChatGPT tools) | MCP server: `list_benchmarks`, `get_benchmark`, `query_prom` tools + `openchainbench://benchmark/{slug}` resource. |
| [`/api/freshness`](https://openchainbench.com/api/freshness) | Live UI, dashboards | `{slug → asOf ms}` map. Edge-cached 5 s. |
| [`/api/llm-context`](https://openchainbench.com/api/llm-context) | LLM system prompts | Every benchmark with rankings + methodology in one Markdown blob. |
| [`/benchmarks/<slug>/opengraph-image`](https://openchainbench.com/benchmarks/aggregator-head-lag/opengraph-image) | X, LinkedIn, Slack, iMessage | 1200×630 PNG with current value + leader + sparkline. Auto-served on link unfurl. |
| [`/benchmarks/<slug>/share-card?template=...`](https://openchainbench.com/benchmarks/aggregator-head-lag/share-card) | Manual export | 5 templates (ranking / snapshot / headline / compare / leaderboard), `?theme=dark` supported. |
| [`/api/badge/<bench>/<provider>`](https://openchainbench.com/api/badge/aggregator-head-lag/mobula) | Provider sites, READMEs | 360×36 embeddable SVG with the provider's rank + headline figure. |
| [`/rss.xml`](https://openchainbench.com/rss.xml) · [`/feed.json`](https://openchainbench.com/feed.json) | Feed readers, agent tooling | RSS 2.0 + JSON Feed 1.1 mirrors, one entry per live bench, updated on release. |
| [`/sitemap.xml`](https://openchainbench.com/sitemap.xml) · [`/robots.ts`](https://openchainbench.com/robots.txt) | Crawlers | Every AI crawler (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, …) explicitly allowed. |

Structured data on every bench page: `Dataset` + `StatisticalReport` + `Observation` + `TechArticle` + `FAQPage` + `BreadcrumbList` JSON-LD, plus a schema.org Dataset microdata graph layered on the visible "At a glance" infobox.

**Journalist citation format** (what `/api/stat/<slug>.headlineSentence` emits):
```
"Mobula leads head lag at 0.8s (p50, 24h) on Fastest onchain data provider.
Source: OpenChainBench (https://openchainbench.com/benchmarks/aggregator-head-lag)"
```

## Site surfaces

| Route | What lives there |
|---|---|
| [`/`](https://openchainbench.com/) | Hero + Latest benchmarks table + Live dashboard |
| [`/benchmarks`](https://openchainbench.com/benchmarks) · `/benchmarks/[slug]` | Catalog grid + per-bench leaderboard with chart, ledger, chain/region filters, share cards, FAQ |
| [`/benchmarks/[slug]/[chain]`](https://openchainbench.com/benchmarks/aggregator-head-lag/solana) | Chain-scoped bench view with per-chain explainer |
| [`/products/[slug]`](https://openchainbench.com/products/mobula) | Per-provider aggregated profile: every bench they appear in, top-1 counts, related products |
| [`/chains/[slug]`](https://openchainbench.com/chains/ethereum) | Per-chain hub: live native price, TVL history, every bench that touches this chain grouped by category |
| [`/compare/[a]-vs-[b]`](https://openchainbench.com/compare/codex-vs-mobula) | Head-to-head comparison across shared benches, canonical alphabetical order enforced at the edge |
| [`/alternatives/[slug]`](https://openchainbench.com/alternatives/alchemy) | "Alternatives to X" landing pages with live leaderboard from the referenced bench |
| [`/answers/[slug]`](https://openchainbench.com/answers/which-crypto-data-api-covers-the-most-blockchains) | Q&A pages backed by a live bench, formatted for AI answer engines |
| [`/hyperliquid`](https://openchainbench.com/hyperliquid) · `/hyperliquid/[slug]` | HyperLiquid frontends cohort + per-builder dashboard (revenue, volume, first-active date) |
| [`/perps`](https://openchainbench.com/perps) · [`/prediction-markets`](https://openchainbench.com/prediction-markets) · [`/rpc`](https://openchainbench.com/rpc) | Vertical hubs aggregating multiple benches per topic |
| [`/mcp`](https://openchainbench.com/mcp) | MCP server docs + install instructions |
| [`/methodology`](https://openchainbench.com/methodology) · [`/contribute`](https://openchainbench.com/contribute) · [`/team`](https://openchainbench.com/team) · [`/about`](https://openchainbench.com/about) · [`/press`](https://openchainbench.com/press) · [`/badges`](https://openchainbench.com/badges) | Static |

## Architecture

```
┌─────────────────────────┐    ┌───────────────────┐    ┌──────────────────────┐
│  50 Go harnesses on     │    │  Shared Prometheus │    │ Materialization worker│
│  ocb-par-main (Paris)   │─── ▶│  (same VPS)        │───▶│ (same VPS, docker)   │
│  each exposes /metrics  │    │  federates a few   │    │ sweeps every 60s     │
└─────────────────────────┘    │  Railway regional  │    └──────┬───────────────┘
                                │  harnesses         │           │
                                └───────────────────┘           ▼
                                                    ┌─────────────────────────┐
                                                    │ Redis + CDN blob store   │
                                                    │ (SRH at kv.opencha…)     │
                                                    └──────────┬──────────────┘
                                                               │
                                                    ┌─────────────────────────┐
                                                    │ Vercel Fluid Compute:    │
                                                    │ pages read CDN blobs     │
                                                    │ first, SRH as fallback,  │
                                                    │ last-known-good on cold  │
                                                    └─────────────────────────┘
```

- **Harnesses + Prometheus + worker + Redis + SRH** run on one VPS (`ocb-par-main` in Paris) via docker compose. A handful of multi-region harnesses (rpc-capabilities-us/eu/sgp, evm-quote-latency, aggregator-head-lag regional) stay on Railway and federate into the VPS Prom.
- **Worker** publishes atomic snapshots every 60 s to Redis + CDN blobs at `kv.openchainbench.com/aggregate/{latest,benches/<slug>,variants/<slug>/<sig>}.json`. Site reads CDN first (~20 ms edge), falls back to SRH, then to the last-known-good snapshot key on cold cache.
- **Site** is Next.js 16 App Router on Vercel Fluid Compute. Auto-deploy from `main` on every push (with sitemap smoke test + auto-rollback + bench-page warm-up); `dev` branch runs on staging preview.
- **Middleware** (`src/middleware.ts`) handles lowercase 308 normalization, `/compare/<b>-vs-<a>` → canonical alphabetical, 410 Gone for removed benches, 301 for renamed ones, and cache-key normalization on read-only public APIs.
- **Live stream relay** (WebSocket at `wss://stream.openchainbench.com/ws`) is a separate service run by Mobula because it holds upstream API keys; the browser talks to it directly, Vercel only serves the static shell.

Full walkthrough with diagrams + a "clone-and-run-it-yourself" section is in [`docs/architecture.md`](./docs/architecture.md).

## Repo layout

```
benchmarks/        94 YAML specs, one per public benchmark
harnesses/         50 Go harnesses, each self-contained + Dockerized
answers/           32 Q&A YAMLs backing /answers/<slug>
alternatives/      23 "alternatives to X" YAMLs backing /alternatives/<slug>
worker/            Materialization worker (sweeps Prom → publishes CDN + Redis blobs)
infrastructure/    Shared Prometheus config
src/               Next.js 16 site (App Router, ISR, Tailwind 4, TypeScript, Zod)
docs/              architecture.md, methodology, walkthrough.md
scripts/           Spec validators + prebuild manifest generators
.github/           CI: prod deploy, staging preview, sync dev from main
```

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the long-form guide. TL;DR:

1. Float an idea in [Discussions](https://github.com/ChainBench/OpenChainBench/discussions)
2. Open a `📊 Propose a benchmark` issue with the metric + methodology
3. Write the harness (Go recommended, any language shipping `/metrics` works)
4. Host it (anywhere with HTTPS + public `/metrics`)
5. Open a PR against `dev`: spec YAML + harness ref + Prom scrape config
6. Review on the staging preview; merge to `main` when data lands

## Editorial conventions

- **Same metric, same conditions**. If two providers can't be measured identically, they don't share a bench.
- **Provider marketing does not shape published numbers**. Public methodology + reproducible harness are the only source of truth.
- **Retirement over removal**. Retired benches return `410 Gone` with a link to the current catalog so previously-indexed URLs decay cleanly.
- **Freshness signals everywhere**. Every citable surface carries `dateModified` + `asOf` so LLMs can tell fresh data from stale.
- **Draft benches never quote a number**. If quorum drops, the page renders "awaiting samples" rather than a fabricated leader.

## Community + license

- **Discussions**: [github.com/ChainBench/OpenChainBench/discussions](https://github.com/ChainBench/OpenChainBench/discussions)
- **Twitter/X**: [@OpenChainBench](https://x.com/OpenChainBench)
- **Wikidata**: [Q140172649](https://www.wikidata.org/wiki/Q140172649)
- **Zenodo DOI**: [10.5281/zenodo.20800311](https://doi.org/10.5281/zenodo.20800311)
- **Hugging Face dataset mirror**: [OpenChainBench/benchmarks](https://huggingface.co/datasets/OpenChainBench/benchmarks) (daily parquet snapshots)

**License**: harness code MIT · dataset CC-BY-4.0 · attribution required. See [LICENSE](./LICENSE).
