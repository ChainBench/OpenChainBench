# perp-liq-rate

Prometheus exporter measuring `liquidated_notional_usd_24h / open_interest_usd * 100` per perpetual DEX venue per asset (ETH, BTC, SOL where available). Polls every 5 minutes, serves gauges on `:2112/metrics`.

## Venues

hyperliquid (ETH/BTC/SOL) · gains (ETH/BTC, Base RPC) · dydx (ETH/BTC/SOL) · gmx (ETH/BTC) · lighter (ETH/BTC) · vertex (ETH/BTC) · aevo (ETH/BTC) · paradex (ETH/BTC)

## Run

```bash
go mod tidy          # first checkout only: materializes go.sum
go run ./cmd/script
```

or

```bash
docker build -t perp-liq-rate .
docker run -p 2112:2112 perp-liq-rate
```

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `TICK_INTERVAL_SECONDS` | `300` | poll interval |
| `RPC_BASE` | `https://mainnet.base.org` | Base mainnet JSON-RPC (gains) |
| `LISTEN_ADDR` | `:2112` | metrics listen address |

## Metrics

```
perp_liq_rate_24h_pct{venue,asset}
perp_liq_volume_24h_usd{venue,asset}
perp_liq_open_interest_usd{venue,asset}
perp_liq_warming_up{venue}
perp_liq_health{venue}
perp_liq_last_refresh_timestamp_seconds{venue}
perp_liq_fetch_errors_total{venue,asset,error_type}
```

`error_type` values: `http_4xx`, `http_5xx`, `http_status`, `timeout`, `decode`, `parse`, `unavailable`, `oi_zero`, `other`.

## Semantics

- Each (venue, asset) pair keeps a thread-safe in-memory sliding window of `(unix_ms, notional_usd)` events plus a dedup key set; both are pruned to 24h every tick.
- All pairs are polled in parallel goroutines per tick behind a `sync.WaitGroup`.
- On fetch error the previously published gauges are kept, `perp_liq_fetch_errors_total` is incremented and the error is logged to stdout; `perp_liq_health{venue}` drops to 0 for the tick.
- `perp_liq_warming_up{venue}` stays 1 until 24h have elapsed since the venue's first tick. Venues with historical endpoints (gains, dydx, gmx, vertex, paradex, and partially lighter) backfill up to 24h on the first tick; hyperliquid/aevo start from their recent-trade depth.
- lighter: HTTP 404/501 marks the venue unavailable (health 0). After 3 consecutive unavailable ticks it logs once and suppresses further error increments/logs until recovery.
- gains: liquidations are decoded from `TradeClosed` logs on the Base diamond (`cancelReason == 1`); a Keccak-256 implementation is embedded (only external dependency allowed is the Prometheus client) and is covered by known-vector tests in `cmd/script/harness_test.go`. Event timestamps are approximated from block distance at ~2 s/block. OI uses DefiLlama Base TVL as a venue-level proxy shared by both assets.

## VERIFY inventory

The upstream API shapes were implemented from the written spec plus the most likely live shapes; every assumption is marked `// VERIFY:` at the exact line. Grep for them before trusting production numbers:

```bash
grep -rn "VERIFY" cmd/script
```

Highlights: the gains `TradeClosed` tuple word offsets (pairIndex / leverage / collateralAmount) and pair indices; hyperliquid's `liquidation` marker field on `recentTrades`; the dydx `perpetualMarkets` map-vs-array shape; gmx subgraph `market` field and gmxinfra `/markets` field names; lighter `/liquidations` params, envelope and market ids; vertex query path, product ids, row/timestamp fields and `max_time` cursor semantics; aevo `/liquidations` existence and timestamp encoding; paradex fills pagination cursor, auth and `open_interest` units.
