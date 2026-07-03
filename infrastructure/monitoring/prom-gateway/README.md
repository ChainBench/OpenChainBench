# prom-gateway

Caddy reverse proxy that sits in front of the OpenChainBench Prometheus on
Railway. The Prom service stays internal-only; this gateway is the single
public entrypoint.

## What it does

- Public read API (`/api/v1/query*`, `/api/v1/series`, `/api/v1/label*`,
  `/metrics`, `/graph`, etc.) passes through unauthenticated. Vercel's bench
  pages keep working with no change.
- Admin API (`/api/v1/admin/*`) plus the lifecycle endpoints (`/-/reload`,
  `/-/quit`) require header `X-Admin-Token: $PROM_ADMIN_TOKEN`. Missing or
  wrong token returns `403 forbidden`.
- `GET /healthz` returns `200 ok` for the Railway healthcheck.
- Access logs go to stdout in JSON.

## How the token works

Set a long random secret in Railway as the `PROM_ADMIN_TOKEN` env var of the
`prom-gateway` service. The Caddyfile reads it at startup via
`{env.PROM_ADMIN_TOKEN}`. Rotate by changing the env var and redeploying;
Prom itself never sees the token.

## Why two Railway services (not a sidecar in the Prom container)

The Prom upstream Dockerfile (`prom/prometheus:v2.49.1`) is kept clean. Caddy
ships as its own service so the two restart, scale and roll independently.
Token rotation = redeploy of ~10 MB of Caddy, the Prom scrape state stays in
RAM. Prom binds to Railway's internal DNS only, so the only way in is through
Caddy.

## Client usage (future delete-ui Next.js app)

```bash
# Read (no auth):
curl -s "https://prom-gateway-production.up.railway.app/api/v1/query?query=up"

# Admin (token required):
curl -X POST -H "X-Admin-Token: $TOKEN" \
  "https://prom-gateway-production.up.railway.app/api/v1/admin/tsdb/delete_series?match[]={benchmark=\"l1-finality\"}"
```

## Railway deploy (step-by-step)

1. In the Railway project that hosts Prometheus, click **+ New** → **Empty Service**. Name it `prom-gateway`.
2. **Settings → Source**: connect this repo, set **Root Directory** to `infrastructure/monitoring/prom-gateway`. Railway picks up the `Dockerfile` and `railway.toml` automatically.
3. **Variables**: add
   - `PROM_ADMIN_TOKEN` = output of `openssl rand -hex 32` (save it in 1Password before pasting).
   - `PROM_UPSTREAM` = `prometheus.railway.internal:9090` (use the actual internal DNS name of your Prom service; check the Prom service's **Settings → Networking → Private Networking**).
4. **Settings → Networking**: click **Generate Domain**. Railway prints a public URL like `prom-gateway-production-xxxx.up.railway.app`.
5. On the existing `prometheus` service: remove its public domain (**Settings → Networking → remove public domain**) so only the gateway is reachable. Prom stays available at `prometheus.railway.internal:9090` for the gateway.
6. Update Vercel env `NEXT_PUBLIC_PROMETHEUS_URL` to the new gateway domain.
