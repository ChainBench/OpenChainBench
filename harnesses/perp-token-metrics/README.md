# perp-token-metrics

Hourly valuation snapshot for perp DEX tokens. Feeds two benches:

- **234 `perp-pe-ratio`**: FDV / annualized protocol revenue.
- **265 `perp-pf-ratio`**: market cap / annualized fees, plus FDV/F, P/S, float, open interest.

## Inputs

| Source | Endpoint | What we take |
|---|---|---|
| DeFiLlama | `GET /summary/fees/{slug}?dataType=dailyFees` | `total24h`, `totalDataChart` (we cut 30d / days 31-60 / 365d ourselves) |
| DeFiLlama | `GET /summary/fees/{slug}?dataType=dailyRevenue` | same, revenue. Flat-zero or missing series = "no revenue data", not zero |
| DeFiLlama | `GET /overview/open-interest` | `protocols[].total24h` keyed by perps child slug |
| CoinGecko | `GET /coins/markets?ids=…` | `market_cap`, `fully_diluted_valuation` (falls back to mcap), `circulating_supply`, `total_supply` |

`/summary/fees/{parent}` aggregates every child product (verified: `hyperliquid` = perps + spot + HLP, `jupiter` = perps + aggregator + lend). The token is measured against its parent so market cap and fees share one scope; the perps-only child is published as `perp_protocol_perp_fees_30d_usd`.

DeFiLlama's derivatives *volume* summary is paid-tier; volume is not read here (the perp-cohort-stats harness publishes `perp_venue_volume_30d_usd`).

## Formulas

```
annual(x)  = sum(last 30 daily points) * 365 / 30
P/F        = mcap / annual(fees)
FDV/F      = fdv  / annual(fees)
P/S        = mcap / annual(revenue)
P/E        = fdv  / annual(revenue)        (bench 234)
rev share  = 100 * rev30d / fees30d
float %    = 100 * circulating / total supply
fees / OI  = annual(fees) / open interest
```

A ratio whose denominator is zero, or whose token has no listing, is **deleted** from the gauge vector rather than set to 0, so a missing value never reads as a zero valuation.

## Coverage (verified 2026-09-12)

| slug | DeFiLlama (token scope) | perps child | CoinGecko | notes |
|---|---|---|---|---|
| hyperliquid | hyperliquid | hyperliquid-perps | hyperliquid | |
| gmx | gmx | gmx-v2-perps | gmx | |
| gains | gains-network | = | gains-network | 100 % float |
| dydx | dydx | dydx-v4 | dydx-chain | |
| drift | drift-trade | = | drift-protocol | adapter reports 0 fees; ratios undefined |
| jupiter | jupiter | jupiter-perpetual-exchange | jupiter-exchange-solana | perps ≈ half of parent fees |
| aster | aster | aster-perps | aster-2 | no revenue series |
| lighter | lighter | lighter-perps | lighter | parent adds Robinhood perps |
| avantis | avantis | = | avantis | no revenue series |
| apex | apex-protocol | apex-omni | apex-token-2 | |
| orderly | orderly-perps | = | orderly-network | parent slug returns null; no revenue |
| synfutures | synfutures | synfutures-v3 | synfutures | |
| derive | derive | derive-v2 | derive | parent adds options |
| ostium, pacifica, extended, edgex, paradex | see main.go | | none | fees + OI only |

Dropped: vertex (no data since acquisition), aevo / grvt / backpack (no DeFiLlama fees series), mux / perpetual-protocol (fees ≈ 0).

## Metrics

All gauges carry `protocol="<slug>"`.

```
perp_protocol_pf_ratio           perp_protocol_fees_24h_usd        perp_protocol_mcap_usd
perp_protocol_pf_fdv_ratio       perp_protocol_fees_30d_usd        perp_protocol_fdv_usd
perp_protocol_ps_ratio           perp_protocol_fees_prev_30d_usd   perp_protocol_float_pct
perp_protocol_pe_ratio           perp_protocol_fees_1y_usd         perp_protocol_oi_usd
perp_protocol_rev_share_pct      perp_protocol_annual_fees_usd     perp_protocol_fees_to_oi_ratio
perp_protocol_rev_24h_usd        perp_protocol_perp_fees_30d_usd   perp_protocol_health
perp_protocol_rev_30d_usd        perp_protocol_annual_rev_usd
```

## Run

```
go test ./...                      # unit tests, fake upstream
ONESHOT=1 METRICS_ADDR=:2112 go run ./cmd/script   # one live poll, then exit
curl -s localhost:2112/metrics | grep perp_protocol_pf_ratio
```

~40 DeFiLlama calls and one CoinGecko call per hour; both public tiers allow this comfortably.
