# Harnesses

Each subdirectory holds the runner for one or more benchmarks — the long-running process that calls providers, measures latency / cost / success, and exposes Prometheus metrics on `/metrics`. The shared OpenChainBench Prometheus (see [`/infrastructure/prometheus`](../infrastructure/prometheus)) scrapes those endpoints, and the site queries Prometheus over HTTPS.

```
harnesses/
├── aggregator-head-lag/   Bench № 001 — WebSocket monitor (Go), exposes :2112/metrics
└── bridge-monitor/        Bench № 002 + № 003 — quote loop + execution (Go), exposes :9090/metrics
```

A single harness can serve multiple benchmarks when the same set of measurements is consumed by more than one spec — `bridge-monitor` is the canonical example, producing both `bridge_quote_latency_ms` (read by `bridge-quote-latency.yml`) and `bridge_cost_percent` (read by `bridge-fee.yml`).

## Contract

A harness is a **data producer**, nothing more. It must:

| Concern | Requirement |
| --- | --- |
| Inputs | Read provider API keys / wallet keys from env vars, never commit them |
| Loop | Run continuously and update the same metric set every iteration |
| Metric names | Match the names referenced in the matching `benchmarks/<slug>.yml` exactly |
| Labels | Include `provider` (or equivalent) and `region` at minimum; chain/route labels encouraged |
| Endpoint | Expose `/metrics` over HTTP on a documented port (e.g. `:2112`, `:9090`). No auth — the central Prometheus scrapes over Railway's internal network |
| Timeouts | Documented; failures fail closed (counted toward success rate, excluded from latency aggregates) |
| Reproducibility | README explains how to run locally with one command |
| License | MIT, same as the rest of the repo |

A harness does **not** ship its own Prometheus, Grafana, Alertmanager, or `docker-compose.yml`. The shared infrastructure handles all of that.

## Subdirectory layout

```
harnesses/<slug>/
├── README.md           What it measures, providers, labels, env vars, port
├── Dockerfile          Container image for the runner
├── .env.example        Every env var the runner reads, with placeholders
└── …                   Source files in whatever language fits
```

## Hosting

Two paths exist for getting a harness into production:

1. **OpenChainBench Railway.** Light harnesses (one HTTP loop, no wallets, no signing) are deployed onto the project's shared Railway. A maintainer creates the service after the PR is merged and adds a corresponding scrape entry in [`infrastructure/prometheus/prometheus.yml`](../infrastructure/prometheus/prometheus.yml).
2. **Contributor-hosted.** Harnesses that hold wallets, sign transactions, or otherwise represent capital must run from infrastructure owned by the contributor. They expose `/metrics` on a publicly-reachable URL and the central Prometheus scrapes it the same way as project-hosted harnesses (the scrape job uses a public hostname instead of `*.railway.internal`).

Either way the YAML spec's `prom_url` always points to the shared OpenChainBench Prometheus — the contributor's hosting choice is invisible to the site.

## Submitting a new harness

See [`/CONTRIBUTING.md`](../CONTRIBUTING.md) for the full submission flow. Short version:

1. Open an issue with the new-benchmark template (sketch the metric, providers, methodology).
2. Write the spec at `benchmarks/<slug>.yml`.
3. Build the harness here at `harnesses/<slug>/`.
4. Append a scrape entry to `infrastructure/prometheus/prometheus.yml`.
5. Open a PR.
