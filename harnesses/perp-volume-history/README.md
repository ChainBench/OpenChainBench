# perp-volume-history

Daily perp DEX volume per venue on closed UTC days, backfilled over a
year and refreshed hourly. Feeds bench 266 (`perp-daily-volume`), the
`/compare/<a>-vs-<b>` daily volume hero and the Perpetuals view on `/products/<venue>` volume
charts.

## Why it exists

DeFiLlama's perp volume API is paid since 2026 (`/overview/derivatives`
and `/summary/derivatives/*` answer 402, the site is behind a Cloudflare
challenge). Its adapters are open source though
(github.com/DefiLlama/dimension-adapters), so this harness reads the
same upstream each adapter reads, on the same UTC day buckets. On
closed days the numbers match defillama.com within each venue's
restatement window, and the whole history stays free to reproduce.

## Sources per venue

| Venue | Upstream (what the DeFiLlama adapter reads) | Backfill |
|---|---|---|
| hyperliquid | `api.hyperliquid.xyz/info` candleSnapshot 1h for every market of the main dex, base volume x hourly mean price (3.361B vs the exchange's own 3.359B dayNtlVlm on 2026-09-13). DeFiLlama's fill indexer is private and the public `daily_usd_volume` feed stopped on 2026-04-03. | 400 d, paged 200 d |
| hyperliquid-hip3 | same, over every HIP-3 dex from `perpDexs` (xyz, io, mkts, para...). Builder-deployed markets, kept apart from the exchange's own row; DeFiLlama's single line covers them only partially. | 400 d |
| gmx | `gmx.squids.live/gmx-synthetics-{arbitrum,avalanche,botanix,megaeth}` volumeInfos 1d marginVolumeUsd x 1e-30 (perps only). Arbitrum required, others additive. | full |
| gains | `backend-global.gains.trade/api/volume-mix?from=D&to=D`, autoVolumeUsd + directVolumeUsd (opens/closes at notional, resizes at traded delta). With `DUNE_API_KEY`: the Dune view `dune.gains.result_g_trade_stats_defi_llama` (the adapter's source) is published and the backend figure feeds `perp_daily_volume_divergence_pct`. ApeChain is in neither. | 400 d at 24 req/min |
| aster | `fapi.asterdex.com/fapi/v1/klines` 1d quoteVolume per TRADING PERPETUAL symbol | 400 d |
| lighter | `/api/v1/candles` 1d `V` per perp market (market_id < 2048) on `mainnet.zklighter.elliot.ai` and `api.rh.lighter.xyz` (Robinhood chain, DeFiLlama's Lighter RH child) | 400 d |
| dydx | `indexer.dydx.trade/v4/candles/perpetualMarkets/<t>` 1DAY usdVolume per market | 400 d, 100 candles per page |
| paradex | public Metabase card 21187, `PERP_VOLUME` per `TRADE_DATE` | full |
| extended | `api.starknet.extended.exchange/api/v1/exchange/stats/trading?fromDate=D&toDate=D` (+ `api.extended.exchange` before 2025-12-29), both sides halved | 400 d |
| orderly | `api-evm.orderly.org/md/volume/daily_stats` | full |
| aevo | `api.aevo.xyz/statistics?instrument_type=PERPETUAL&end_time=<ns>` per day | 400 d |

`DEFILLAMA_API_KEY` switches every venue to
`pro-api.llama.fi/<key>/api/summary/derivatives/<slug>?dataType=dailyVolume`.

Not covered yet: edgeX, GRVT, Pacifica (per-market candles, same
pattern), Vertex, Backpack, Jupiter (no public daily history), Drift and
Ostium (Dune only on DeFiLlama).

## Outputs

Prometheus on `:2112/metrics`:

| Gauge | Labels | Meaning |
|---|---|---|
| `perp_daily_volume_usd` | venue, window=1d/7d/30d | last closed UTC day; 7d and 30d sums, published only when every day of the window is present |
| `perp_daily_volume_share_pct` | venue, window | share of the cohort on the window |
| `perp_daily_volume_cohort_usd` | window | cohort total |
| `perp_daily_volume_history_days` | venue | stored days (bench sample_size) |
| `perp_daily_volume_health` | venue | 1 when a closed day landed within 3 days |
| `perp_daily_volume_source` | venue, source | 1 for the upstream producing the venue |
| `perp_daily_volume_divergence_pct` | venue, secondary | secondary vs published gap over the refreshed days |
| `perp_daily_volume_last_refresh_unix`, `perp_daily_volume_fetch_errors_total`, `perp_daily_volume_last_tick_unix` | | observability |

JSON on `:2112/v1/history[?days=N][&venue=slug]` and mirrored to
`HISTORY_FILE_PUBLIC`:

```json
{ "generated_at": "...", "last_closed_day": "2026-09-13",
  "venues": [ { "slug": "gmx", "name": "GMX V2", "source": "gmx-squid", "note": "...",
                "days": [ { "day": "2025-08-11", "usd": 123.0 }, ... ] } ] }
```

On the OCB VPS the public file lives in `/data/state/aggregate/perp-volume/` (the directory Caddy already serves as `/aggregate/`)
and Caddy serves it at `https://kv.openchainbench.com/aggregate/perp-volume/history.json`
(the site reads that URL; override with `PERP_VOLUME_HISTORY_URL`).

## Env

| Var | Default | Meaning |
|---|---|---|
| `HISTORY_FILE` | `/data/perp-volume-history.json` | store (mount a volume) |
| `HISTORY_FILE_PUBLIC` | unset | where to mirror the public JSON |
| `BACKFILL_DAYS` | `400` | horizon walked back on first boot, bounded by each source's start |
| `REFRESH_DAYS` | `3` | closed days re-read every tick (sources restate D-1) |
| `TICK_MINUTES` | `60` | sweep cadence |
| `METRICS_ADDR` | `:2112` | |
| `DUNE_API_KEY`, `DUNE_SQL_QUERY_ID` | unset, `3996608` | Gains via the Dune view (one execution per sweep, free tier holds) |
| `DEFILLAMA_API_KEY` | unset | all venues via DeFiLlama Pro |

## Run

```bash
go run ./cmd/script            # local, store in /data unless HISTORY_FILE is set
curl -s localhost:2112/metrics | grep perp_daily_volume_usd
curl -s 'localhost:2112/v1/history?days=30&venue=gains' | jq .
```

A first sweep with the 400 day backfill takes about 25 minutes (Aster
and Hyperliquid candle fan-out dominate); gauges from the store are
published before the sweep starts, so a restart never blanks them.
Hourly sweeps re-read three days per venue and take about 15 minutes.

```bash
docker build -t ocb-perp-volume-history .
docker run -p 2112:2112 -v /data/state/perp-volume:/data \
  -e HISTORY_FILE_PUBLIC=/data/public/history.json ocb-perp-volume-history
```
