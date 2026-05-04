# Harnesses

One harness folder per benchmark, one Go binary per folder, one Railway service per binary. The Mobula-hosted services emit metrics that the shared OpenChainBench Prometheus scrapes; the site queries that Prometheus.

```
harnesses/
├── aggregator-head-lag/      Bench № 001 (Go, exposes :2112/metrics)
├── bridge-quote-latency/     Bench № 002 (Go, exposes :9090/metrics)
├── bridge-fee/               Bench № 003 (Go, exposes :9090/metrics)
└── metadata-coverage/        Bench № 004 (Go, exposes :2112/metrics)
```

## Hosting model

Federation, not centralization. Each harness is run by whoever owns it. The current four are hosted by Mobula on Railway as a sponsorship contribution; new contributors host their own and submit a scrape config so the central Prometheus picks them up.

You never share API keys with the project. Your harness runs with your credentials, on your infra, on your dime; only the metric values it publishes are public.

## Contract

Every harness, regardless of language, must satisfy this contract:

| Concern | Requirement |
| --- | --- |
| Inputs | Read API keys / wallet keys from environment variables, never commit them |
| Loop | Run continuously and update the same metric set every iteration |
| Metric names | Match the names referenced in the matching `benchmarks/<slug>.yml` exactly |
| Labels | Include `provider` (or equivalent) and `region` at minimum; chain/route labels encouraged |
| Endpoint | Expose `/metrics` over HTTPS on a publicly reachable URL |
| Timeouts | Documented; failures fail closed |
| Reproducibility | README explains how to run locally with one command |
| License | MIT, same as the rest of the repo |

A harness does not ship its own Prometheus, Grafana, or Alertmanager. The shared infrastructure handles that.

## Subdirectory layout

```
harnesses/<slug>/
├── README.md           What it measures, providers, labels, env vars, port
├── Dockerfile          Container image for the runner
├── .env.example        Every env var the runner reads, with placeholders
└── …                   Source files in whatever language fits
```

## Submitting a new harness

See [`/CONTRIBUTING.md`](../CONTRIBUTING.md) for the full submission flow.
