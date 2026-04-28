# Harnesses

Each subdirectory holds the actual benchmark script for one report — the thing that runs continuously, calls providers, and pushes metrics to Prometheus.

```
harnesses/
├── aggregator-quote/         (Bench № 001)
├── bridge-e2e/               (Bench № 002)
├── feed-freshness/           (Bench № 003)
└── rpc-head-lag/             (Bench № 004)
```

## Contract

A harness is whatever you need it to be — Bun, Node, Python, Rust, a cron-runner shell script. The contract it must satisfy is small:

| Concern        | Requirement                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Inputs         | Read provider API keys from env vars, never commit them                                         |
| Loop           | Run continuously (or on a fixed cadence ≥ 24h) and push the same metric set every iteration     |
| Metric names   | Match the names in the matching `benchmarks/<slug>.yml` exactly                                 |
| Labels         | At minimum `provider`, `region`. Additional labels (chain, route) are encouraged                |
| Push target    | `pushgateway` or remote-write to the project's Prometheus                                       |
| Timeouts       | Documented, fail closed (count toward success rate)                                             |
| Reproducibility| README explains how to run it locally with one command                                          |
| License        | MIT, same as the rest of the repo                                                               |

## Subdirectory layout

A harness is expected to ship at minimum:

```
harnesses/<slug>/
├── README.md         What it measures, the providers, the labels, env vars, how to run
├── Dockerfile        Container image for the runner
├── Makefile or run.sh   `make run` (or `./run.sh`) starts the loop
└── …                 Source files in whatever language fits
```

The point isn't uniformity for its own sake; it's that any contributor can `cd` into a folder and figure out what's happening in 30 seconds.

## Submitting a new harness

See [`/CONTRIBUTING.md`](../CONTRIBUTING.md) for the full submission flow. tldr:

1. Add the editorial mock in `src/data/benchmarks.ts`.
2. Add the spec in `benchmarks/<slug>.yml`.
3. Add the harness here.
4. Open a PR.
