# Infrastructure

Shared services that every benchmark depends on. Hosted by the OpenChainBench Railway project; the layout here is what gets deployed.

```
infrastructure/
└── prometheus/        Single shared Prometheus instance scraped by the site
    ├── Dockerfile
    └── prometheus.yml Scrape config — one job per harness
```

## How the system fits together

```
OpenChainBench Railway project
├── prometheus              ← this folder, public read-only URL
├── aggregator-head-lag     ← from harnesses/aggregator-head-lag
├── bridge-monitor          ← from harnesses/bridge-monitor
└── <future-harness>        ← from harnesses/<slug>

         ▲                                ▲
         │ scrape every 15 s              │
         │                                │
       Each harness exposes /metrics on a known port (Railway internal DNS)
       Prometheus aggregates everything and exposes a single public URL.

Each YAML spec in benchmarks/<slug>.yml has prom_url pointing at the
public Prometheus URL. The Next.js site queries Prometheus directly.
```

A contributor never has to think about Prometheus. They drop their harness in `harnesses/<slug>/`, append one block to `prometheus.yml` here, and the data flows.

## Why no Grafana / Alertmanager in this folder

Grafana and Alertmanager are useful for ops but they're not part of the public surface — the OpenChainBench site renders its own visualizations from PromQL, and alerting is a per-operator concern. Anyone running their own fork is welcome to add either alongside; the harnesses don't depend on them.

If you need to debug Prometheus visually, you can:

- Browse `https://<prom-url>/graph` directly (Prometheus ships its own UI).
- Spin up Grafana locally pointed at the public Prometheus URL — no infra changes required.

## Scrape config — adding a target

`prometheus.yml` lists one `scrape_configs` job per harness. To add a new harness:

```yaml
- job_name: <slug>
  metrics_path: /metrics
  scheme: http
  static_configs:
    - targets:
        - <slug>.railway.internal:<port>
      labels:
        benchmark: <slug>
```

Three things to get right:

1. **`<slug>` matches the Railway service name.** Railway exposes each service at `<service-name>.railway.internal:<port>` — the job's target string must match.
2. **`<port>` matches the port the harness binds for `/metrics`.** Conventionally 2112 (aggregator-style) or 9090 (bridge-style); whatever your harness chooses, document it in `harnesses/<slug>/README.md`.
3. **`benchmark: <slug>` label.** All metrics get this label automatically; the YAML spec uses it to scope queries to a specific harness. Keep it consistent with the spec slug.

After merging a PR that adds a job, redeploy the `prometheus` Railway service so it picks up the new config (or hit the `/-/reload` endpoint with `--web.enable-lifecycle` enabled — already on by default in this Dockerfile).

## Running this locally

```bash
cd infrastructure/prometheus
docker build -t openbench-prom .
docker run --rm -p 9090:9090 openbench-prom
```

The local Prometheus will fail to scrape the `*.railway.internal` targets (those resolve only inside Railway). To exercise locally, edit `prometheus.yml` to point at `host.docker.internal:<port>` while you run the harness on your laptop.

## Retention

Default retention is 365 days, configurable via the `PROM_RETENTION` Railway env var. The site queries up to 7 days back for time-series panels (the `series7d` window) — anything older is for archival and ad-hoc queries.

## Why Railway over a managed Prom

- Cost: a single ~$5/mo Railway service vs $20+/mo for managed Prom plans
- Same DNS network as the harnesses → no public ingress per harness needed
- Trivial to redeploy / wipe / split if scaling demands it
