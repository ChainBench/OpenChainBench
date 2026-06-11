# hyperliquid-frontends-local

Local harness that reads the hl-node L1 output directly from
`/mnt/hyperliquid/data/node_fills_by_block/hourly/` instead of fetching the
public daily CSV bucket. Produces the same per-builder metrics as the
`hyperliquid-frontends` harness but at sub-minute freshness instead of 24-48h
lag.

Deployed on the OVH SGP server where the hl-node runs. Exposes Prometheus
metrics on `127.0.0.1:2113/metrics`, fronted by Caddy with basic auth on
`:8088` for OCB Prom scraping.

Metrics emitted (all labeled by `slug`):

- `hl_frontend_volume_usd_24h_v2`
- `hl_frontend_fees_usd_24h_v2`
- `hl_frontend_users_24h_v2`
- `hl_frontend_fills_total_24h_v2`
- `hl_frontend_effective_fee_bps_v2`
- `hl_frontend_local_last_tick_unix_v2` (heartbeat)

Run flags:

```
hl-frontends-local \
  -data /mnt/hyperliquid/data/node_fills_by_block/hourly \
  -builders builders.json \
  -addr 127.0.0.1:2113 \
  -window-hours 24 \
  -tick 30s
```
