# perp-fees harness

Source for OpenChainBench bench [`perp-fees`](https://openchainbench.com/benchmarks/perp-fees). Measures the all-in cost (in bps) to open a $1,000 ETH long 10x perpetual futures position on each venue: taker fee + half-spread + price impact.

Exposes Prometheus metrics on `:2112/metrics`.

## Venues tracked

| Venue | Source |
|---|---|
| Hyperliquid | `POST /info` orderbook + userFees + funding |
| dYdX v4 | indexer orderbook + perpetualMarkets funding + Cosmos REST fee tier |
| GMX v2 (Arbitrum) | Subsquid GraphQL `positionFeeFactorForNegativeImpact` + gmxinfra REST funding |
| Lighter | `/orderBookDetails` taker fee + `/orderBookOrders` orderbook walk |
| gains.trade (v8 on Base) | `eth_call` on the on-chain fee oracle |

Cadence: every 5 minutes, in parallel across all venues. Failed scrapes leave the previous gauge in place and increment `perp_fees_fetch_errors_total`.

## Metrics

```
perp_fees_all_in_bps{venue, chain}              gauge — total cost (taker + spread)
perp_fees_taker_fee_bps{venue, chain}           gauge — taker fee component
perp_fees_spread_bps{venue, chain}              gauge — half-spread component
perp_fees_fetch_errors_total{venue, chain}      counter
perp_fees_last_refresh_timestamp_seconds{venue, chain}  gauge
perp_fees_health{venue, chain}                  gauge — 1 if last scrape succeeded
```

## Run locally

```bash
go run ./cmd/script        # binds :2112
# or
docker build -t perp-fees .
docker run -p 2112:2112 perp-fees
curl localhost:2112/metrics | grep perp_fees
```

No API keys required. All sources are public REST / RPC.

## Environment

| Var | Default | Notes |
|---|---|---|
| `PROM_LISTEN_ADDR` | `:2112` | listen address for the Prometheus scrape endpoint |
| `LOGS_TOKEN` | (unset) | optional, gates `/logs?tail=N` for remote log inspection |

See [`.env.example`](./.env.example) for the template.

## Notes

The harness has no off-chain config beyond venue endpoints. Each venue's quote logic lives in `cmd/script/<venue>.go` (`dydx.go`, `gmx.go`, `hyperliquid.go`, `lighter.go`, `gains.go`). Adding a venue is one file + a registration in `main.go`.
