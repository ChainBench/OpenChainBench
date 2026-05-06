# Benchmark specs

One YAML file per benchmark, one source of truth.

## How a spec becomes a published report

```
benchmarks/<slug>.yml
        │
        ▼
src/lib/spec.ts ──► Prometheus HTTP API ──► live numbers
        │                                          │
        ▼                                          ▼
src/data/benchmarks.ts (mock fallback)  ───► Benchmark[]
        │
        ▼
   Paper-styled report at /benchmarks/<slug>
```

If Prometheus answers, the page renders live numbers. If it doesn't (network error, no metrics yet, missing labels), the page falls back to the mock entry of the same `slug` in `src/data/benchmarks.ts` so the report still ships.

## Submitting a new benchmark

1. **Pick a slug.** Lowercase, hyphenated, e.g. `wallet-portfolio-latency`.
2. **Add the editorial mock.** Append a new entry to `MOCK_BENCHMARKS` in `src/data/benchmarks.ts` with title, abstract, methodology, findings, providers and placeholder numbers. The mock is what readers see until the harness fills Prometheus.
3. **Create the spec.** Drop a `benchmarks/<slug>.yml` in this directory with the Prometheus URL and the PromQL queries (see `aggregator-quote-latency.yml` for shape).
4. **Open a PR.** The build picks the spec up automatically.

## Spec reference

```yaml
slug: my-benchmark            # required, lowercase-hyphenated
number: "006"                 # required, 3-digit string
title: Short editorial title  # required, used as the H1
seo_title: Long SEO title     # optional, browser tab + meta only — falls back to title
subtitle: One-line dek        # required
category: Data                # required: Aggregators | Bridges | Data | Wallets | RPCs
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
source: https://github.com/...  # required, link to the harness folder

prometheus:
  url: https://prom.example   # required for live data; else override via PROMETHEUS_URL env var
  window: 24h                 # window for rate()/quantile aggregations — default 24h

# Optional drill-down dimensions. When set, the bench page renders a
# tab selector and the queries get a label filter injected server-side.
# Currently supported: chain.
dimensions:
  chain:
    - { value: solana, label: Solana }
    - { value: bnb,    label: BNB Chain }

providers:
  - slug: provider-slug       # required, kebab-case
    name: Provider Name       # required, display name
    tag: Short tagline        # optional, rendered next to the name
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

### Notes on the new fields

- **`unit: count`** — for benches that publish a single gauge (e.g. number of supported chains). The bench page swaps to a leaderboard layout (no p50/p90/p99 boxes, no 24-hour chart) since those are meaningless on a count.
- **`higher_is_better`** — affects how the homepage card, ledger table, mini-chart legend and Compare share-card are sorted, and what label the Compare card prints (`Cheaper by` / `More expensive by` / `Covers more by` / `Slower by` etc.).
- **`seo_title`** — the long, search-friendly title used in `<title>`, OpenGraph and Twitter cards. The H1 stays the shorter `title`.
- **`dimensions.chain`** — when set, the bench page renders chain-tab pills above the chart. Picking a chain re-fetches Prom with `chain="<value>"` injected into every label selector. Cached separately per (slug, chain) tuple.

When `region.series` is set on every region, the time-series chart shows
a "Region" selector (All · US-East · EU-West · …) so readers can slice the
multi-line plot by region. The chart works the same way for every spec —
single-region specs simply hide the selector.

## Failure modes

| Situation                               | Result                                       |
| --------------------------------------- | -------------------------------------------- |
| No spec file                            | Mock data renders                            |
| Spec found, Prometheus URL unset        | Mock data renders                            |
| Spec found, queries time out / 500     | Mock data renders                            |
| Any provider's `p50/p90/p99` is `null` | Mock data renders (we don't ship half-live)  |
| Everything works                        | Live data renders, mock metadata layered in  |

This is intentionally conservative: half-live data is worse than mock data because readers can't tell which numbers to trust.
