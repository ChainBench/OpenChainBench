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
slug: my-benchmark            # required, must match the mock's slug
prometheus:
  url: https://prom.example   # required for live data; else override via PROMETHEUS_URL env var
  window: 24h                 # window for rate()/quantile aggregations — default 24h

providers:
  - slug: provider-slug       # must match a `slug` under `results:` in the mock
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
        - region: eu-west
          p50: <PromQL>
        - region: ap-southeast
          p50: <PromQL>
```

## Failure modes

| Situation                               | Result                                       |
| --------------------------------------- | -------------------------------------------- |
| No spec file                            | Mock data renders                            |
| Spec found, Prometheus URL unset        | Mock data renders                            |
| Spec found, queries time out / 500     | Mock data renders                            |
| Any provider's `p50/p90/p99` is `null` | Mock data renders (we don't ship half-live)  |
| Everything works                        | Live data renders, mock metadata layered in  |

This is intentionally conservative: half-live data is worse than mock data because readers can't tell which numbers to trust.
