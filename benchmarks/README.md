# Benchmark specs

One YAML file per benchmark, one source of truth.

## How a spec becomes a published report

```
benchmarks/<slug>.yml
        │
        ▼
src/lib/spec-schema.ts         ← Zod contract
        │
        ▼
worker/index.ts (Railway)      ← materializer, sweeps Prom every 60s and
        │                        writes per-(bench, variant) snapshots
        ▼
Redis snapshot store (Upstash)
        │
        ▼
src/lib/spec.ts                ← reads snapshots, falls back to live Prom
        │                        when a snapshot is missing or too old
        ▼
src/data/benchmarks.ts         ← async getters
        │
        ▼
Next.js App Router (ISR 60s)
        │
        ▼
Paper-styled report at /benchmarks/<slug>
```

There is no mock fallback. If Prometheus has nothing (no harness yet, transient outage with no snapshot in store) the page renders in `draft` state with an "Awaiting first run" notice. Half-live data is worse than no data because readers can't tell which numbers to trust.

## Submitting a new benchmark

The long-form contributor guide is [`/CONTRIBUTING.md`](../CONTRIBUTING.md). Short version:

1. **Pick a slug.** Lowercase, hyphenated, e.g. `wallet-portfolio-latency`.
2. **Open an issue** with the [Propose a benchmark template](https://github.com/ChainBench/OpenChainBench/issues/new?template=new-benchmark.yml). Get methodology feedback before writing code.
3. **Create the spec** at `benchmarks/<slug>.yml`. Format below. Use `aggregator-head-lag.yml` as a reference.
4. **Build and host the harness** (see [`harnesses/README.md`](../harnesses/README.md)).
5. **Wire the scrape** in `infrastructure/prometheus/prometheus.yml`.
6. **Open a PR against `dev`.** CI runs `pnpm check` (validate + typecheck + lint + test).

## Spec reference

```yaml
slug: my-benchmark            # required, lowercase-hyphenated, must match filename
number: "006"                 # required, 3-digit string (read the highest existing
                              #            number in benchmarks/ and increment)
title: Short editorial title  # required, used as the H1
seo_title: Long SEO title     # optional, browser tab + meta only. falls back to title
subtitle: One-line dek        # required
category: Data                # required: Aggregators | Bridges | Blockchains |
                              #           Data | Trading | Wallets | RPCs
status: live                  # default: live; "draft" hides results, keeps editorial
metric: Field coverage        # required, label rendered above the values
unit: pct                     # required: ms | s | pct | bps | count
higher_is_better: true        # default false. Set true for coverage / count benches.
abstract: |                   # required, ≥40 chars, lead paragraph for "About"
  Why this benchmark, what it measures...
methodology:                  # required, ≥1 bullet
  - "First constraint"
  - "Second constraint"
findings: []                  # optional, ordered list rendered after the data
source: https://github.com/...  # required, link to the harness folder (or YAML
                                #            for harnesses still in private repos)

prometheus:
  url: https://prom.openchainbench.com  # required, shared Prom URL (override per
                                        # deploy via PROMETHEUS_URL env var)
  window: 24h                 # window for rate()/quantile aggregations. default 24h

# Optional drill-down dimensions. When set, the bench page renders a
# tab selector and the queries get a label filter injected server-side.
# Currently supported: chain.
dimensions:
  chain:
    - { value: all,    label: All chains }
    - { value: solana, label: Solana }
    - { value: bnb,    label: BNB Chain }

providers:
  - slug: provider-slug       # required, kebab-case
    name: Provider Name       # required, display name
    tag: Short tagline        # optional, rendered next to the name
    type: aggregator          # optional, architectural category for apples-to-
                              #           apples framing (protocol | aggregator |
                              #           intent | relay)
    queries:
      p50: <PromQL>            # required for live mode
      p90: <PromQL>            # required for live mode
      p99: <PromQL>            # required for live mode
      mean: <PromQL>           # optional
      success: <PromQL>        # optional, fraction in [0,1] or percentage
      sample_size: <PromQL>    # optional, scalar sample count
      series: <PromQL>         # optional, range query for the 24h sparkline
      regions:                 # optional, per-region p50 for small multiples
        - region: us-east
          p50: <PromQL>
          series: <PromQL>     # optional, per-region series for the chart's region tab
        - region: eu-west
          p50: <PromQL>
          series: <PromQL>
        - region: ap-southeast
          p50: <PromQL>
          series: <PromQL>
```

### Notes on selected fields

- **`unit: count`**. for benches that publish a single gauge (e.g. number of supported chains). The bench page swaps to a leaderboard layout (no p50/p90/p99 boxes, no 24-hour chart) since those are meaningless on a count.
- **`higher_is_better`**. affects how the homepage card, ledger table, mini-chart legend and Compare share-card are sorted, and what label the Compare card prints (`Cheaper by` / `More expensive by` / `Covers more by` / `Slower by` etc.).
- **`seo_title`**. the long, search-friendly title used in `<title>`, OpenGraph and Twitter cards. The H1 stays the shorter `title`.
- **`dimensions.chain`**. when set, the bench page renders chain-tab pills above the chart. Picking a chain re-fetches Prom with `chain="<value>"` injected into every label selector. Cached separately per (slug, chain) tuple. Your harness must emit the `chain` label for this to work.
- **`providers[].type`**. used by bridge / aggregator benches so readers can tell whether the comparison is apples-to-apples (protocol vs intent vs aggregator). Reviewers will ask for it on benches that mix architectural categories.

When `region.series` is set on every region, the time-series chart shows a "Region" selector (All · US-East · EU-West · …) so readers can slice the multi-line plot by region. The chart works the same way for every spec — single-region specs simply hide the selector.

## Failure modes

| Situation                               | Result                                       |
| --------------------------------------- | -------------------------------------------- |
| Spec file missing                       | Route doesn't exist                          |
| Spec parses but no Prometheus data yet  | Draft page: "Awaiting first run"             |
| Spec OK, snapshot fresh                 | Live report                                  |
| Spec OK, snapshot stale, live Prom OK   | Live report from fallback path               |
| Per-provider query fails this sweep     | Provider keeps last good value with `staleSince` (carry-forward) |
| Worker down beyond freshness window     | Site falls back to live-Prom loader          |

This is intentionally conservative: half-live data is worse than no data because readers can't tell which numbers to trust.

## Dev-only benches (held out of prod)

Specs that ship on staging (`dev`) but are intentionally held out of production releases until cleared. Publishing one = include its YAML in the next `dev → main` release branch. Do **not** fast-forward `dev` from `main`: the release branches strip these files and an ff would wipe them from dev. Current hold list lives in `release/dev-to-main` PR templates; check recent merge history for the canonical set.
