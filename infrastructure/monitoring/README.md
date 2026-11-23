# monitoring

Shared monitoring stack for OpenChainBench. Consumed by every benchmark (`aggregator-head-lag`, `metadata-coverage`, `bridge-monitor`, etc.) — not by any single one.

## Layout

```
prometheus/    Prometheus server: scrapes the harness services in this Railway
                project, which is the only thing that can: they live on
                *.railway.internal, private DNS the VPS cannot resolve.
grafana/       Grafana dashboards for internal ops use. Reads the Prometheus above.
alertmanager/  Receives alerts from Prometheus rules, routes to the ops webhook.
prom-gateway/  Caddy reverse proxy — the single public entrypoint in front of Prometheus.
```

### The site does NOT query this Prometheus

It used to, and the line above said so until 2026-10-29, but it has been wrong
for a while and the mistake is expensive. The real path is:

```
railway probe --> this Prom --> prom-gateway --> VPS Prom (job federate-railway, 30s)
                                                     ^
                           prom.openchainbench.com ---+--- the site reads only this
```

`PROMETHEUS_URL` in Vercel points at `prom.openchainbench.com`, the VPS. Every
spec that pins its own `prometheus.url` pins the same host. Nothing in the repo
names the Railway host. So:

- This instance is a scrape hub and a 30 second buffer, not an archive. Its
  retention only has to cover a federation outage.
- When a harness moves to the VPS, **delete its scrape job here in the same
  PR**. 24 jobs were left pointing at hosts that no longer resolve.
- A job the VPS federation filter excludes by name is pure cost: stored and
  compacted here, read by nobody.

### Which Prometheus loads which rule file

Both instances read from this directory, and the split is by location, not by
name. Get it wrong and you either pay twice for the same rule or publish a
panel with no series behind it.

| Path | Loaded by | Why |
| --- | --- | --- |
| `prometheus/recording_rules/*.yml` | Railway only | `COPY recording_rules/` in the Dockerfile |
| `prometheus/*.yml` (loose) | VPS only | hand-copied to `/opt/ocb/prom-rules/`, mounted read-only |

A rule belongs with the harness that feeds it. `ocb_gas_estimation.yml` sat in
`recording_rules/` after the gas harness moved to the VPS, so Railway evaluated
it against no data, the VPS never evaluated it at all, and
`benchmarks/gas-estimation.yml` published a panel whose series existed nowhere.

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

Then redeploy the Prometheus service. Two more things have to be true before
the site can read it, and neither is automatic:

1. The job must pass the VPS federation filter in `/opt/ocb/prometheus.yml`
   (job `federate-railway`). That filter is a negative job matcher, so a new
   job is included by default, but check you are not reusing an excluded name.
2. A recording rule for it belongs in `recording_rules/` only if the data is
   scraped here. If the harness later moves to the VPS, the job and its rule
   both move with it.

## Migration note

This stack previously built from the private Mobula monorepo (`miniapps/openchainbench-monitoring/`). It was ported here on 2026-07-03 so the public OCB repo is the canonical build source for every Railway service; all inline credentials were externalised to env vars in the process.
