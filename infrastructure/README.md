# Infrastructure

The single shared service every benchmark depends on: a central Prometheus.

```
infrastructure/
├── prometheus/        Shared Prometheus that scrapes every harness's /metrics
│   ├── Dockerfile
│   └── prometheus.yml Scrape config. one job per benchmark
├── monitoring/        Full Railway monitoring stack: prometheus + grafana +
│                      alertmanager + prom-gateway (see monitoring/README.md)
├── monitoring-ui/     Internal control plane (bench state dashboard, Railway)
└── prom-admin/        Admin UI for per-bench Prom TSDB wipes (Railway)
```

## How OpenChainBench's data plane works

OpenChainBench is a federation. **Each harness is hosted by whoever wrote it**. Mobula for the existing aggregator and bridge benchmarks, independent contributors for any future ones, a provider that wants to be benchmarked on its own service. The only piece of infrastructure shared across the project is this Prometheus.

```
[Mobula's infra]          [Contributor B's infra]      [Provider C's infra]
   harness A serves           harness B serves              harness C serves
   /metrics on                /metrics on                   /metrics on
   <public URL>               <public URL>                  <public URL>
        │                          │                              │
        └──────────────────────────┼──────────────────────────────┘
                                   ▼
                  ┌────────────────────────────────────┐
                  │ OpenChainBench Prometheus          │
                  │ scrapes every public /metrics URL  │
                  │ config: prometheus.yml (this dir)  │
                  └────────────────┬───────────────────┘
                                   │ HTTPS, /api/v1/query
                                   ▼
                          openchainbench.com
                          (Next.js site on Vercel)
```

A contributor never needs to think about Prometheus, Grafana, or any shared infra. They run their harness wherever it makes sense (Railway, Fly, Cloud Run, a VPS) and expose `/metrics` over HTTPS. the central scraper picks it up. They never need credentials for the OpenChainBench Prometheus.

## Why a single shared Prometheus

- **One URL in every YAML spec.** Every benchmark's `prom_url` points at the same Prometheus, so the site queries one source of truth.
- **No data movement.** Each harness keeps its own latency / cost data on its own infra; Prometheus pulls it on a schedule. If a harness goes down, only that benchmark's data is affected.
- **Federation-friendly.** Adding a contributor-hosted harness is just one new `scrape_configs` block. no key sharing, no infrastructure migration.

## Why no Grafana / Alertmanager in this folder

Grafana and Alertmanager are useful for ops but they're not part of the public surface. the OpenChainBench site renders its own visualizations from PromQL, and alerting is a per-operator concern. Anyone running their own fork is welcome to add either alongside; the harnesses don't depend on them.

If you need to debug Prometheus visually, you can:

- Browse `https://<prom-url>/graph` directly (Prometheus ships its own UI).
- Spin up Grafana locally pointed at the public Prometheus URL. no infra changes required.

## Adding a target. the contributor flow

When a new harness is ready (deployed somewhere with public `/metrics`), append a job to `prometheus.yml`:

```yaml
- job_name: <slug>
  metrics_path: /metrics
  scheme: https
  static_configs:
    - targets:
        - <public-host>          # e.g. my-harness.fly.dev
      labels:
        benchmark: <slug>
        host: <contributor>      # optional, e.g. mobula | alice | acme-rpc
```

Three things to get right:

1. **Public reachability.** The host must be reachable from the OpenChainBench Prometheus over HTTPS. No `*.railway.internal` or VPN-only addresses.
2. **`benchmark: <slug>` label.** All metrics get this label automatically; the YAML spec uses it to scope queries to a specific harness. Keep it consistent with the slug.
3. **Stable URL.** If your hosting changes the URL, you (or a maintainer) need to update this file.

After merging the PR, redeploy the `prometheus` Railway service so it picks up the new config (or hit `/-/reload`. `--web.enable-lifecycle` is enabled in the Dockerfile by default).

## Currently configured targets

| Job | Hosted by | Where the data comes from |
| --- | --- | --- |
| `aggregator-head-lag` | Mobula | `harnesses/aggregator-head-lag` running on Mobula Railway |
| `bridge-monitor` | Mobula | `harnesses/bridge-monitor` running on Mobula Railway (powers benches № 002 + № 003) |
| `metadata-coverage` | Mobula | Pulse V2 feeder + metadata worker running on Mobula Railway |
| `network-coverage` | Mobula | `harnesses/network-coverage` running on Mobula Railway |
| `prometheus` | self | the OpenChainBench Prom itself (health metrics) |

When external contributors onboard, they appear here.

## Running this locally

```bash
cd infrastructure/prometheus
docker build -t openbench-prom .
docker run --rm -p 9090:9090 openbench-prom
```

The local Prometheus will fail to scrape the public targets if your network doesn't allow outbound HTTPS to them. If you want to test against your own harness, edit `prometheus.yml` to point at `host.docker.internal:<port>` while you run the harness on your laptop.

## Retention

Default retention is 365 days, configurable via the `PROM_RETENTION` Railway env var. The site queries up to 7 days back for time-series panels; older data is for archival and ad-hoc queries.

## Why Railway over a managed Prom

- Cost: a single ~$5/mo Railway service vs $20+/mo for managed Prom plans
- Single-binary deployment, single config file. nothing to patch over time
- Trivial to redeploy / wipe / split if scaling demands it

## Self-hosting the OpenChainBench Prometheus

A central OpenChainBench Prometheus is now live and scrapes every harness declared in this `prometheus.yml`. The site queries it through the URL set in each spec's `prometheus.url` field (or the global `PROMETHEUS_URL` env var as a fallback). Forking the project means deploying your own Prometheus (this folder builds a Railway-ready image) and pointing your fork's specs at it. The Mobula-hosted instance is one valid implementation; nothing in the spec format depends on who runs it.
