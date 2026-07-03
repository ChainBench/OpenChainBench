# hl-archive — Railway deploy

Single-region single-instance Go service. Ingests Hyperliquid CDN dumps
into a local DuckDB file, exposes a read-only HTTP API + Prometheus
metrics on `:2114`, and republishes a snapshot to Upstash for the OCB
site SSR.

## Prereqs

- Railway CLI: `npm i -g @railway/cli` then `railway login`
- Linked to the OCB Railway project: `railway link` from the monorepo root
- One Upstash Redis (REST) database, same project as the OCB site
- A 32-byte random API key for the service (see below)

## First-time deploy

Build context is the monorepo root, not the miniapp dir. Run from
`mobula-api/` (not from `miniapps/hl-archive/`), otherwise Railway will
upload only the miniapp tree and the Dockerfile path will not resolve.

```bash
cd /path/to/mobula-api

# 1. Create the service in the OCB project (one-time).
railway service create hl-archive

# 2. Point your local checkout at it.
railway service hl-archive

# 3. Set the secrets. Mark HL_ARCHIVE_API_KEY and
#    UPSTASH_REDIS_REST_TOKEN as "Sensitive" in the Railway dashboard
#    afterwards (the CLI cannot flip that bit).
railway variables set \
  HL_ARCHIVE_API_KEY="$(openssl rand -base64 32)" \
  UPSTASH_REDIS_REST_URL="https://<your>.upstash.io" \
  UPSTASH_REDIS_REST_TOKEN="<token>"

# 4. Add the persistent volume in the dashboard:
#    Service -> Settings -> Volumes -> Add -> name=hl-archive-duckdb,
#    mountPath=/data. railway.toml also declares it; whichever side
#    creates it first wins.

# 5. Deploy.
railway up
```

Subsequent deploys: a git push to the branch tracked by the Railway
service triggers a rebuild automatically, or `railway up` from the
monorepo root for an out-of-band deploy.

## First-boot backfill

On cold boot with an empty `/data/history.duckdb`, the service walks
upstream CDN dumps from `HL_ARCHIVE_BACKFILL_FROM` (default
`2025-08-01`) forward to "yesterday UTC". Expect ~10-30 min of CPU on
the first run depending on bucket size; subsequent daily runs at
`HL_ARCHIVE_CRON_HOUR=2` (UTC) only fetch the previous day.

To kick a manual backfill of a specific range without waiting for the
cron, exec into the running container and call the binary's CLI mode:

```bash
railway run hl-archive backfill --from=2025-08-01 --to=2025-08-31
```

(The same binary serves both `serve` and `backfill` subcommands; the
container default is `serve`.)

## Logs & metrics

- **Logs**: Railway dashboard -> `hl-archive` -> Logs. JSON-structured
  via slog, shippable to BetterStack/Loki without reformatting.
- **Metrics**: scraped by the shared OCB Prometheus at
  `hl-archive.railway.internal:2114/metrics` (job `hl-archive` in
  `miniapps/openchainbench-monitoring/prometheus/prometheus.yml`).
  Key gauges: `hl_archive_lag_hours`, `hl_archive_db_size_bytes`,
  `hl_archive_files_processed_total`, `hl_archive_cron_runs_total`.
- **Healthcheck**: `GET /health` on port 2114, no auth required.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `IO Error: Could not set lock on file` on boot | Two service replicas attached to the same DuckDB volume | Scale to 1 replica. DuckDB is single-writer; multi-replica is not supported. |
| `401 unauthorized` on Upstash REST calls in logs | `UPSTASH_REDIS_REST_TOKEN` missing or rotated | Re-set the env var, redeploy. Confirm the URL matches the same Upstash DB the token was issued for. |
| `403` / `429` from `stats-data.hyperliquid.xyz` during backfill | CDN throttling on bulk fetch | Reduce parallel fetches inside the harness (already capped, but a noisy neighbour on the egress IP can still trip it). Wait 10-15 min, the cron will retry on the next tick. |
| Healthcheck "failing" in Railway despite live `/metrics` | `PORT` env not set to `2114` | Confirm `PORT=2114` (the harness binds 2114 hardcoded, Railway probes `$PORT`). |
| Container restarts on every push | DuckDB file corrupted by an OOM mid-write | Stop the service, attach a one-shot container to the volume, run `duckdb /data/history.duckdb "PRAGMA database_size;"` to confirm, then either drop the file (full backfill on next boot) or restore from the last Upstash snapshot. |
