# hyperliquid-frontends

One Go process feeds three OpenChainBench benches without a node, a key or a
cloud account:

- № 030 `hyperliquid-frontends`: builder-code revenue, volume and wallets per
  Hyperliquid frontend, from the public per-builder daily fills feed.
- № 035 `hyperliquid-hip3-deployers`: volume, markets and open interest per
  HIP-3 dex, from the Hyperliquid info API.
- № 036 `perp-funding`: normalized funding rates across venues (`funding.go`).

It replaces the harness that tailed a self-hosted `hl-node` (retired
2026-09-24). Metric names and labels are unchanged so the site, the recorded
history and the /hyperliquid hub kept working; only the semantics of "24h"
moved from a rolling window to the last complete UTC day.

## Data sources

**Builder fills feed.** Hyperliquid publishes one lz4-compressed CSV per
builder address and UTC day:

```
https://stats-data.hyperliquid.xyz/Mainnet/builder_fills/<address>/<YYYYMMDD>.csv.lz4
```

Columns (2026-09): `time,user,coin,side,px,sz,crossed,special_trade_type,tif,
is_trigger,counterparty,closed_pnl,twap_id,builder_fee`. Day D is published
early on D+1 (observed 02:45 to 03:30 UTC). A file that does not exist answers
403, which is also what a builder with no fills that day gets. HIP-3 fills
routed through a builder are present (`coin` like `xyz:AAPL`) but the deployer
fee is not.

**Info API.** `POST https://api.hyperliquid.xyz/info` with `{"type":"perpDexs"}`
lists HIP-3 dexes (namespace, full name, deployer);
`{"type":"metaAndAssetCtxs","dex":"<name>"}` returns per market the rolling 24h
notional (`dayNtlVlm`), open interest and mark price.

## How the feed side works

1. **Mirror.** Every fetched CSV is stored under `<data>/builder_fills/<address>/`.
   A 403 writes a `<day>.absent` marker with the check time. Days younger than
   `-grace-days` (3) are re-requested on every pass until the batch lands;
   older 403s are final. Files older than the window are pruned.
2. **Feed day.** After each pass without transport failures the harness
   picks the newest day within the grace span that has at least
   `-min-published` (5) files whose newest CDN upload (Last-Modified, kept as
   the file mtime) is older than `-settle` (45 min). The choice only moves
   forward, so a half-uploaded batch is never read. A builder whose file
   failed to download keeps its previous gauges; $0 is published only when
   every address answered 403. `hl_frontend_data_day_unix_v2` and
   `_end_unix_v2` say which day the gauges describe.
3. **Publish.** For the feed day D: fees, notional, fills, taker share, distinct
   wallets, coin shares. 7d/30d = the files of the 7/30 UTC
   days ending on D; wallet counts are unions. 30d wallet totals feed the
   volume-by-percentile buckets and the profitable-user share (`closed_pnl`).
4. **Ledger.** Per builder per day totals are persisted in `<data>/state.json`.
   A one-off backfill walks from `-ledger-from` (2026-06-01, the first day the
   retired node observed) to the window and then deletes the files. Once every
   day is complete (`hl_frontend_ledger_complete` = 1) the biggest day and the
   10k/100k/1m revenue milestones publish. Revenue deltas need the prior
   window in the ledger and are absent until then.

Restarts publish from the mirror before touching the feed. Roughly 3,500
requests on a cold start (104 builders × 33 days), then ~100 to 300 per
30-minute pass.

## Metrics

Builder gauges, label `builder` = registry slug, suffix `_v2`:

- `hl_frontend_fees_usd_{24h,7d,30d}_v2`, `hl_frontend_volume_usd_{24h,7d,30d}_v2`
- `hl_frontend_users_{24h,7d,30d}_v2`, `hl_frontend_fills_total_24h_v2`
- `hl_frontend_effective_fee_bps_v2`, `hl_frontend_fees_per_user_usd_v2`, `hl_frontend_taker_pct_v2`
- `hl_frontend_global_volume_share_24h_v2` (denominator = tracked cohort)
- `hl_frontend_revenue_delta_pct_v2{window}`, `hl_frontend_biggest_day_{revenue_usd,unix}_v2`
- `hl_frontend_milestone_revenue_days_v2{threshold}`, `hl_frontend_profitable_user_pct_30d_v2`
- `hl_frontend_volume_by_percentile_30d_v2{bucket}`, `hl_frontend_coin_volume_share_24h_v2{coin}`
- `hl_frontend_data_day_unix_v2`, `hl_frontend_data_day_end_unix_v2`, `hl_frontend_local_last_tick_unix_v2`
- `hl_frontend_feed_fetch_total{result}`, `hl_frontend_feed_files_present`, `hl_frontend_ledger_complete`

HIP-3 gauges, label `dex` = namespace:
`hl_hip3_deployer_volume_usd_{24h,7d,30d}`, `hl_hip3_deployer_markets_24h`,
`hl_hip3_deployer_markets_listed`, `hl_hip3_deployer_open_interest_usd`,
`hl_hip3_deployer_days_sampled`, `hl_hip3_deployer_info{full_name,deployer}`,
`hl_hip3_last_tick_unix`. The 7d/30d sums use one 24h sample per UTC day,
recorded by the first poll after midnight.

Funding gauges (`perp_funding_*`) are documented in `funding.go`.

Dropped with the node: `last_fill_age_seconds`, `fills_per_min`,
`price_deviation_bps`, `asset_volume_top_usd` and every `hl_hip3_deployer_fees_*`,
`_users_*`, `_fills_24h`, `_effective_fee_bps`, `_last_fill_age_seconds` series.

## Builder registry (`builders.json`)

Hand-curated array of `{slug, name, address, addresses?, valid_from, notes}`.
`address` is canonical; `addresses` lists extra builder addresses for frontends
that route through several (all merged into one row). Slugs and addresses must
be unique across entries; the loader refuses a registry that maps one address
to two slugs. Entries whose slug is a bare `0x…` prefix are unlabeled
addresses kept for coverage; they are fetched and exported but not listed in
the spec. `scripts/sync-hypertracker.py` diffs the registry against
HyperTracker's public builder list.

## Run

```
go run ./cmd/script \
  -builders builders.json \
  -data ./data \
  -addr :2112 \
  -window-days 30 -grace-days 3 -min-published 5 -settle 45m \
  -poll 30m -workers 6 \
  -ledger-from 2026-06-01 \
  -hip3-every 10m -funding-every 60s
```

`/metrics`, `/logs` (ring buffer of stdout) and `/health` are served on
`-addr`. The Dockerfile builds a static binary that runs as `nonroot` and
expects a writable volume on `/data`.

```
docker build -t ocb-hyperliquid-frontends .
docker run -d --name ocb-hyperliquid-frontends --restart unless-stopped \
  --network ocb_web --network-alias hyperliquid-frontends \
  -v /data/state/hyperliquid-frontends:/data --memory 1536m ocb-hyperliquid-frontends
```
