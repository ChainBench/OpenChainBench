# Harnesses

Each subdirectory holds the runner for one or more benchmarks — the long-running process that calls providers, measures latency / cost / success, and pushes metrics to Prometheus. The OpenChainBench site queries that same Prometheus and renders the data.

```
harnesses/
├── aggregator-head-lag/   Bench № 001 — WebSocket monitor (Go)
└── bridge-monitor/        Bench № 002 + № 003 — quote loop + execution (Go)
```

A single harness can serve multiple benchmarks when the same set of measurements is consumed by more than one spec — `bridge-monitor` is the canonical example, producing both `bridge_quote_latency_ms` (read by `bridge-quote-latency.yml`) and `bridge_cost_percent` (read by `bridge-fee.yml`).

## Contract

A harness can be written in any language. The contract it must satisfy is small:

| Concern | Requirement |
| --- | --- |
| Inputs | Read provider API keys / wallet keys from env vars, never commit them |
| Loop | Run continuously and push the same metric set every iteration |
| Metric names | Match the names referenced in the matching `benchmarks/<slug>.yml` exactly |
| Labels | Include `provider` (or equivalent) and `region` at minimum; chain/route labels encouraged |
| Push target | Scrape endpoint exposed for Prometheus, or push to a remote-write endpoint |
| Timeouts | Documented; failures fail closed (counted toward success rate, excluded from latency aggregates) |
| Reproducibility | README explains how to run it locally with one command |
| License | MIT, same as the rest of the repo |

## Subdirectory layout

A harness is expected to ship at minimum:

```
harnesses/<slug>/
├── README.md           What it measures, providers, labels, env vars, how to run
├── Dockerfile          Container image for the runner
├── .env.example        Every env var the runner reads, with placeholders
└── …                   Source files in whatever language fits
```

If the harness ships a full local stack (Prometheus + Grafana + Alertmanager) it should include a `docker-compose.yml` and a `Makefile` for the common targets (`make run`, `make logs`, `make stop`). The two existing harnesses do.

## Hosting

Two paths exist for getting a harness into production:

1. **OpenChainBench Railway.** Light harnesses (one HTTP loop, no wallets, no signing) can be deployed onto the project's shared Railway. A maintainer wires the service after the PR is merged.
2. **Contributor-hosted.** Harnesses that hold wallets, sign transactions, or otherwise represent capital must run from infrastructure owned by the contributor. They push metrics to a publicly-reachable Prometheus endpoint and the site queries it the same way as the project-hosted harnesses.

Either way the YAML spec's `prom_url` decides which Prometheus the site reads from — the data path is identical.

## Submitting a new harness

See [`/CONTRIBUTING.md`](../CONTRIBUTING.md) for the full submission flow. Short version:

1. Open an issue with the new-benchmark template (sketch the metric, providers, methodology).
2. Write the spec at `benchmarks/<slug>.yml`.
3. Build the harness here at `harnesses/<slug>/`.
4. Open a PR.
