# pm-cohort-stats

Per-venue prediction-market cohort exporter for the OCB PM benches and the
`/benches/pm-*` product pages.

## What it does

Polls Polymarket gamma-api, Kalshi REST, and DefiLlama `/protocols` on a
fixed cadence, computes the OCB-canonical per-venue cohort metrics, and
exposes Prometheus gauges on `:2112/metrics` that the OCB site reads from
on every SSR render of the PM pages.

## Sources & gauges

| Gauge | Source | Cadence |
|---|---|---|
| `pm_venue_volume_30d_usd{venue}` | Polymarket gamma `/markets` `volume1mo`, Kalshi `/markets` `volume`, DefiLlama `/protocols` | 5 min (polymarket, kalshi), 15 min (defillama) |
| `pm_venue_volume_24h_usd{venue}` | Polymarket `volume24hr`, Kalshi `volume_24h` | 5 min |
| `pm_venue_open_interest_usd{venue}` | Polymarket `openInterest`, Kalshi `open_interest * last_price`, DefiLlama TVL fallback | 5 min (polymarket, kalshi), 15 min (defillama) |
| `pm_venue_active_markets{venue}` | Count of open markets from `/markets` | 5 min |
| `pm_venue_top_market_volume_24h_usd{venue}` | `max(volume24hr)` across active markets | 5 min |
| `pm_venue_markets_above_1m{venue}` | Count of markets with all-time `volume >= 1m` | 5 min |

Plus observability:
- `pm_cohort_stats_last_refresh_timestamp_seconds{venue, source}`
- `pm_cohort_stats_fetch_latency_milliseconds{venue, source}`
- `pm_cohort_stats_fetch_errors_total{venue, source, error_type}`
- `pm_cohort_stats_last_tick_unix`

## Venue registry

The set of venues (slug, name, onchain/offchain, settlement chain) is
hardcoded in `cmd/script/registry.go`. It MUST mirror the OCB site's PM
venue registry. Adding a new venue:

1. Append to `Registry` in `cmd/script/registry.go`
2. Append on the OCB site
3. Redeploy both

Today's set:

| Slug | Type | Chain | Source |
|---|---|---|---|
| polymarket | onchain | polygon | gamma-api |
| kalshi | offchain | (n/a) | Kalshi REST |
| limitless | onchain | base | DefiLlama fallback |
| manifold | offchain | (n/a) | DefiLlama fallback |
| myriad | offchain | (n/a) | DefiLlama fallback |

## Env vars

| Var | Default | Required |
|---|---|---|
| `POLYMARKET_REFRESH_MINUTES` | `5` | Optional override. |
| `KALSHI_REFRESH_MINUTES` | `5` | Optional override. |
| `DEFILLAMA_REFRESH_MINUTES` | `15` | Optional override. |

No API keys required: every source is public read-only.

## Port

Hardcoded `:2112` per the OCB harness convention. The shared Prom-gateway
on Railway is configured to scrape `:2112` from every OCB harness. Do not
listen on `$PORT`; Railway sets that env var for its proxy layer and the
harness ignores it.

## Graceful degradation

- Polymarket gamma 5xx / 429 -> the page break is taken, gauges left at
  their previous value (Prom carry-forward), a fetch-errors counter is
  incremented with the bucketed `error_type`.
- Kalshi REST 5xx / 429 -> same: skip this tick, next ticker call retries.
- DefiLlama `/protocols` lookup miss for a venue -> counter incremented
  with `error_type="not_tracked"`; gauges left untouched.
- One source going down does not poison any other source: each runs on
  its own goroutine loop with its own ticker.

## Local run

```bash
POLYMARKET_REFRESH_MINUTES=5 \
KALSHI_REFRESH_MINUTES=5 \
DEFILLAMA_REFRESH_MINUTES=15 \
go run ./cmd/script

# In another terminal:
curl -s http://localhost:2112/metrics | grep '^pm_venue_' | head
```
