# monitoring

Shared monitoring stack for OpenChainBench. Consumed by every benchmark (`aggregator-head-lag`, `metadata-coverage`, `bridge-monitor`, etc.) — not by any single one.

## Layout

```
prometheus/    Prometheus server — scrapes every harness service in this Railway project.
                The site openchainbench.com queries this Prom (through prom-gateway) via HTTP API.
grafana/       Grafana dashboards for internal ops use. Reads the Prometheus above.
alertmanager/  Receives alerts from Prometheus rules, routes to the ops webhook.
prom-gateway/  Caddy reverse proxy — the single public entrypoint in front of Prometheus.
```

Each subfolder is an independent Railway service deployed from its own Dockerfile (set the Railway **Root Directory** to `infrastructure/monitoring/<subdir>`).

## Service mapping (Railway)

| Folder | Railway service | Exposure |
| --- | --- | --- |
| `prometheus/` | Prometheus | internal only — fronted by `prom-gateway` |
| `prom-gateway/` | prom-gateway | public read API, token-gated admin API |
| `grafana/` | Grafana | internal ops dashboards |
| `alertmanager/` | alertmanager | internal alert routing → ops webhook |

## Secrets

No secret lives in this directory. Every credential is injected at runtime via Railway env vars — see `.env.example` for the full list and which service each var belongs to:

- `HL_BENCH_LOCAL_AUTH` (prometheus) — materialised to a `password_file` by `prometheus/entrypoint.sh` because Prom 2.x does not expand env vars in scrape configs.
- `ALERT_WEBHOOK_URL` (alertmanager) — substituted into `alertmanager.yml.tmpl` at container start by `alertmanager/entrypoint.sh`.
- `GF_SECURITY_ADMIN_USER` / `GF_SECURITY_ADMIN_PASSWORD` (grafana) — read natively by Grafana.
- `PROM_ADMIN_TOKEN` / `PROM_UPSTREAM` (prom-gateway) — read by the Caddyfile via `{env.*}`.

## Adding a new scrape target

When a new harness service is deployed (e.g. for a new OpenChainBench benchmark), append a job to `prometheus/prometheus.yml` :

```yaml
  - job_name: '<bench-slug>'
    static_configs:
      - targets:
        - '<bench-slug>.railway.internal:<port>'
        labels:
          benchmark: <bench-slug>
    metrics_path: /metrics
```

Then redeploy the Prometheus service. The new metrics start flowing into the same Prom and become queryable from the site.

## Migration note

This stack previously built from the private Mobula monorepo (`miniapps/openchainbench-monitoring/`). It was ported here on 2026-07-03 so the public OCB repo is the canonical build source for every Railway service; all inline credentials were externalised to env vars in the process.
