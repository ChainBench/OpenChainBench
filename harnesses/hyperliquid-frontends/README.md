# hyperliquid-frontends-local

Local harness that reads the hl-node L1 output directly from
`/mnt/hyperliquid/data/node_fills_by_block/hourly/` instead of fetching the
public daily CSV bucket. Produces the same per-builder metrics as the
`hyperliquid-frontends` harness but at sub-minute freshness instead of 24-48h
lag.

Deployed as a systemd unit (`hl-frontends-local.service`) on the OVH server
where the hl-node runs. Exposes Prometheus metrics on `127.0.0.1:2113/metrics`,
fronted by Caddy with basic auth on `:8088` for OCB Prom scraping.

One binary feeds three benches: № 030 hyperliquid-frontends (builder
revenue), the HIP-3 deployers bench, and № 036 perp-funding (the funding
poller shares the process).

## Metrics

Per-builder gauges, labeled by registry `slug` (windows: `24h`, `7d`, `30d`):

- `hl_frontend_fees_usd_{24h,7d,30d}_v2` — USD builder fees (headline)
- `hl_frontend_volume_usd_{24h,7d,30d}_v2` — notional routed
- `hl_frontend_users_{24h,7d,30d}_v2` — unique wallets with ≥1 attributed fill
- `hl_frontend_fills_total_24h_v2`, `hl_frontend_fills_per_min_v2`
- `hl_frontend_effective_fee_bps_v2` — volume-weighted fees/notional
- `hl_frontend_fees_per_user_usd_v2`
- `hl_frontend_taker_pct_v2`, `hl_frontend_price_deviation_bps_v2`
- `hl_frontend_last_fill_age_seconds_v2` — outage detector
- `hl_frontend_asset_volume_top_usd_v2{asset,rank}` — top coins per builder
- `hl_frontend_local_last_tick_unix_v2` — harness heartbeat

HIP-3 deployer gauges (labeled by deployer dex namespace):
`hl_hip3_deployer_{fees,volume}_usd_{24h,7d,30d}`,
`hl_hip3_deployer_{users_{24h,7d,30d},fills_24h,markets_24h,effective_fee_bps,last_fill_age_seconds}`.

Perp-funding gauges (bench № 036, labeled by venue/market):
`perp_funding_{rate_hourly_bps,hold_24h_bps,annualized_pct,interval_hours,venue_ok_unix,last_tick_unix}`.
The poller hits HL/Binance/Bybit/OKX/dYdX/Paradex/Aster public endpoints every
60s. It only starts after the fills warmup replay, so funding series are
absent for a few minutes after every restart.

## Builder registry (`builders.json`)

Hand-curated array of `{slug, name, address, valid_from, notes}` — currently
~104 entries. Conventions:

- `address` is the canonical builder address; an optional `addresses` array
  tracks frontends that route through multiple builder addresses (e.g. Okto).
  All are matched lowercased.
- `valid_from` is documentation (when the builder joined / when we verified
  it), not a filter — the harness counts whatever is in the on-disk window.
- The registry is loaded once at startup: editing it requires a service
  restart, which replays the warmup window from disk before serving.
- Beware name collisions: two unrelated products can share a brand name with
  different builder addresses (this happened with FOMO — the DefiLlama
  `fomo-perps` address is not the FOMO social app). Verify against node fills
  before trusting an external mapping.

### Keeping coverage honest

`scripts/sync-hypertracker.py` diffs the registry against HyperTracker's
public builder list (static JSON on their CDN, ~1200 builders, ~335 labeled):

```
python3 scripts/sync-hypertracker.py [--all-time-min 10000] [--h24-min 100]
```

It reports labeled builders missing from the registry above the revenue
thresholds, plus name/address collisions. Read-only — additions ship via PR.
Builder addresses outside the registry stay visible in the raw node stream
but off the leaderboard until added.

## Run flags

```
hl-frontends-local \
  -data /mnt/hyperliquid/data/node_fills_by_block/hourly \
  -builders builders.json \
  -addr 127.0.0.1:2113 \
  -window-hours 24 \
  -tick 30s
```
