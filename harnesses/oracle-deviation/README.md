# oracle-deviation — OpenChainBench № 025 + № 082

Compares four price oracles in real time across ten USD pairs and
publishes the per-pair deviation as Prometheus gauges (bench № 025).
The same process also tracks oracle freshness (bench № 082):
staleness in seconds derived from each oracle's own last-update
timestamp, for Chainlink on three chains, Pyth via Hermes and
RedStone via its public per-symbol API.

## Sources

| Source    | Transport                                     | Auth | Cadence |
| --------- | --------------------------------------------- | ---- | ------- |
| Chainlink | `eth_call` on AggregatorV3 (Ethereum mainnet) | none | 30 s    |
| Pyth      | Hermes REST `/api/latest_price_feeds` (batch) | none | 30 s    |
| Binance   | REST `/api/v3/ticker/price`                   | none | 30 s    |
| Coinbase  | REST `/products/<P>/ticker`                   | none | 30 s    |

Freshness-only sources (№ 082, never enter the № 025 deviation matrix):

| Source              | Transport                                        | Auth | Cadence |
| ------------------- | ------------------------------------------------ | ---- | ------- |
| Chainlink Arbitrum  | `eth_call` on AggregatorV3 (ETH/USD)             | none | 30 s    |
| Chainlink Base      | `eth_call` on AggregatorV3 (ETH/USD)             | none | 30 s    |
| RedStone            | REST `/prices?symbol=<S>&provider=redstone`      | none | 30 s    |

## Pairs

BTC, ETH, SOL, BNB, XRP, ADA, DOGE, AVAX, LINK, MATIC — all quoted
against USD. Binance's `*USDT` and Pyth's `POL/USD` (for MATIC) are
treated as USD-equivalent; see caveat below.

## Caveats

- **USDT ≈ USD.** Binance only quotes against USDT. We treat the two
  as equivalent (typical drift ≤ 0.1 %), which is acceptable for a
  bench whose alert floor is ≥ 0.1 % deviation. A persistent USDT
  depeg would surface as Binance drifting from the other three
  sources for *every* pair, which is exactly what we want this bench
  to flag.
- **MATIC = POL on Pyth & Coinbase.** Polygon migrated MATIC → POL
  in Sep 2024 (1:1). Chainlink still exposes the `MATIC/USD` feed
  contract; Coinbase delisted MATIC-USD and only lists POL-USD; Pyth
  renamed the feed to POL/USD. All four sources track the same
  underlying asset.
- **Chainlink update cadence ≠ poll cadence.** Chainlink updates
  on-chain only on deviation or heartbeat (typically hourly for
  blue-chips). `ocb_oracle_last_round_age_seconds` exposes the gap
  between the on-chain `updatedAt` and now, so a slow oracle is
  visible without confusing it with a stalled poller.

## Metrics

```
ocb_oracle_price{source, pair}                              gauge
ocb_oracle_deviation_pct{pair, source_a, source_b}          gauge
ocb_oracle_max_deviation_pct{pair}                          gauge
ocb_oracle_update_latency_seconds{source, pair}             gauge
ocb_oracle_scrape_errors_total{source, pair}                counter
ocb_oracle_last_round_age_seconds{source="chainlink", pair} gauge
```

Bench № 082 (freshness) families. New label set (`oracle`, `pair`,
`chain`) instead of adding a `chain` label to the № 025 families,
which would have split their series and changed the live bench's
numbers:

```
ocb_oracle_staleness_seconds{oracle, pair, chain}              gauge (s)
ocb_oracle_update_events_total{oracle, pair, chain}            counter
ocb_oracle_stale_but_moved{oracle, pair, chain}                gauge (0/1)
ocb_oracle_freshness_scrape_errors_total{oracle, pair, chain}  counter
```

`chain` is where the freshness timestamp lives: `ethereum` /
`arbitrum` / `base` for Chainlink deployments, `hermes` for Pyth
(publish_time), `gateway` for RedStone (signed data-package
timestamp). `stale_but_moved` is 1 when staleness > 300 s AND the
Binance/Coinbase reference moved > 0.5 % since the update was
observed (thresholds documented in `freshness.go`).

The headline ranking signal for the OCB leaderboard is
`ocb_oracle_max_deviation_pct` — a per-pair quantile over time
(`quantile_over_time(0.95, ocb_oracle_max_deviation_pct[24h])`)
flags which assets disagree most across providers.

## Endpoints

- `GET /metrics` — Prometheus exposition
- `GET /health` — always 200 `ok` as long as the HTTP server is up

The listener is hardcoded to `:2112` (OCB Railway convention, ignore
`$PORT`).

## Local run

```bash
go mod tidy
go build ./cmd/script
./script
curl -s :2112/metrics | grep ocb_oracle_max_deviation_pct
```

## Env overrides

| Variable                 | Default                                     |
| ------------------------ | ------------------------------------------- |
| `ORACLE_RPC_PRIMARY`     | `https://ethereum-rpc.publicnode.com`       |
| `ORACLE_RPC_FALLBACK`    | `https://eth.llamarpc.com`                  |
| `ORACLE_RPC_ARBITRUM`    | `https://arbitrum-one-rpc.publicnode.com`   |
| `ORACLE_RPC_BASE`        | `https://base-rpc.publicnode.com`           |
| `ORACLE_REDSTONE_URL`    | `https://api.redstone.finance/prices`       |
| `ORACLE_METRICS_ADDR`    | `:2112` (local-run override only)           |
