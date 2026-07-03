# perp-cohort-stats

Per-venue perp-DEX cohort exporter for the OCB perp benches and
`/benches/perp-*` product pages.

## What it does

Polls Hyperliquid info, Lighter mainnet info, DefiLlama protocol pages,
and the Mobula CEFI funding-rate aggregator on a single 60 s sweep,
applies a per-metric source priority, cross-checks divergent sources,
and exposes Prometheus gauges on `:2112/metrics` that the OCB site
reads on every SSR render of the perp pages.

## Sources & gauges

| Gauge | Primary source | Fallback |
|---|---|---|
| `perp_venue_volume_24h_usd{venue}` | HL native / Lighter native | DefiLlama HTML |
| `perp_venue_volume_30d_usd{venue}` | DefiLlama HTML | (none) |
| `perp_venue_oi_usd{venue}` | HL native / Lighter native | DefiLlama HTML |
| `perp_venue_fees_30d_usd{venue}` | DefiLlama HTML | (none) |
| `perp_venue_active_markets{venue}` | HL native / Lighter native | DefiLlama HTML |
| `perp_venue_top_market_volume_24h_usd{venue}` | HL native / Lighter native | (none) |
| `perp_venue_health{venue}` | derived per tick | n/a |
| `perp_venue_funding_24h_bps{venue, asset}` | Mobula funding-rate | (none) |
| `perp_venue_funding_interval_hours{venue, asset}` | Mobula funding-rate | (none) |

Plus observability:

- `perp_venue_last_refresh_unix{venue, source}`
- `perp_cohort_stats_source_used{venue, metric, source}` (1 for the source that served the value)
- `perp_cohort_stats_fetch_errors_total{venue, source, error_type}`
- `perp_cohort_stats_data_divergence_total{venue, metric}`
- `perp_cohort_stats_last_tick_unix`

## Venue registry

The set of venues is hardcoded in `cmd/script/registry.go`. It MUST
mirror the OCB site's perp venue registry. Adding a new venue:

1. Append to `Registry` in `cmd/script/registry.go`
2. Add per-metric priority entries in `adapter.go priorityMap()`
3. Append on the OCB site
4. Redeploy both

Today's set:

| Slug | Name | Chain |
|---|---|---|
| hyperliquid | Hyperliquid | hyperliquid |
| lighter | Lighter | zksync |
| gmx-v2 | GMX V2 | arbitrum |

## Env vars

| Var | Default | Required |
|---|---|---|
| `TICK_INTERVAL_SECONDS` | `60` | Optional override |
| `MOBULA_API_KEY` | hardcoded fallback | Optional override |
| `MOBULA_FUNDING_VENUES` | 12-venue CEFI cohort | Optional override |

## Port

Hardcoded `:2112` per the OCB harness convention. The shared Prom
gateway on Railway is configured to scrape `:2112` from every OCB
harness. Do not listen on `$PORT`; Railway sets that env var for its
proxy layer and the harness ignores it.

## Graceful degradation

- Any single source 4xx / 5xx -> `perp_cohort_stats_fetch_errors_total`
  bucketed by `error_type`. The router falls through to the next source
  in the priority list for that (venue, metric).
- Full miss for a (venue, metric) -> in-memory carry-forward
  republishes the last known value but does NOT advance
  `perp_venue_last_refresh_unix`, so the UI can compute true age.
- Cross-check between primary and secondary: when both return non-zero
  and disagree by more than 10 percent, increment
  `perp_cohort_stats_data_divergence_total{venue, metric}`. Publication
  always picks the primary; the counter is informational.
- Each source runs in its own goroutine on every sweep with a 15 s HTTP
  timeout. One source going down does not block any other source.

## Local run

```bash
TICK_INTERVAL_SECONDS=60 go run ./cmd/script

# In another terminal:
curl -s http://localhost:2112/metrics | grep '^perp_venue_' | head
```

## Build & deploy

The Dockerfile mirrors `pm-cohort-stats`:

```
docker build -t perp-cohort-stats .
docker run -p 2112:2112 perp-cohort-stats
```

Railway: connect to the `feat/perp-cohort-stats` branch, set
`PROMETHEUS_SCRAPE_ENABLED=true` on the shared Prom gateway (or wire
the new service into the Caddy sidecar config used by the other OCB
harnesses), and verify `/metrics` returns non-zero `perp_venue_*`
families.
