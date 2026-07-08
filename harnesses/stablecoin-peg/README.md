# stablecoin-peg

OpenChainBench harness - live stablecoin peg deviation vs $1.00 across CEX + on-chain venues.

## What it measures

Per stablecoin, every minute:

| Metric | What it answers |
|---|---|
| `peg_deviation_bps` | Current absolute deviation from $1 in basis points, aggregated across USD-quoted venues. |
| `peg_cross_venue_gap_bps` | Max - min price across USD-quoted venues — **OCB's differentiator, nobody else publishes this.** |
| `peg_time_outside_band_24h_seconds` | Seconds in last 24h the price was outside [0.995, 1.005]. |
| `peg_depeg_event_flag` | 1 when stable has been > 300 bps off-peg for ≥5 consecutive minutes. Cleared after 30 min recovery. |
| `peg_time_below_peg_seconds` / `peg_time_above_peg_seconds` | Direction split — surfaces asymmetric redemption (Circle redeems above-peg only). |
| `peg_deviation_usdt_anchored_bps` | Secondary metric for USDT-quoted samples (Binance), excluded from primary to avoid USDT contamination. |

## Methodology in one paragraph

For each stable, every venue's bid/ask is polled (5 s for CEX, 12 s for on-chain). Samples are bucketed per minute, median per venue per minute, then a **liquidity-weighted median across venues** gives the canonical per-stable price for that minute. Deviation = `|price - 1.00| × 10000` in bps. The primary metric uses **USD-quoted samples only** (Coinbase USDT-USD, Kraken, Bitstamp, plus the Curve 3pool for DAI). USDT-quoted samples (Binance USDC/USDT) feed a secondary metric so USDT's own peg drift doesn't contaminate every other stable's number. Outlier rule is multi-venue consensus: a sample > 2% off peg is kept only when another venue corroborates it in the same direction within 30 s; > 50% off is treated as a parser bug and dropped.

The DAI price is the geometric mean of Curve 3pool `get_dy` quoted in both directions (USDC→DAI and DAI→USDC). Both directions embed the same pool swap fee, so the geometric mean cancels it exactly; only genuine pool imbalance moves the number, which keeps the DAI series comparable to CEX mid prices.

The bench page on openchainbench.com sorts the ledger on `quantile_over_time(0.50, peg_deviation_worst_bps[24h])` (the 24 h median of the per-minute worst deviation); the p99 column shows `quantile_over_time(0.99, ...)`, the depeg-tail number.

## Stables and venues

| Stable | Sources (quote) | Notes |
|---|---|---|
| USDC | Kraken USDCUSD ($63M), Bitstamp usdcusd ($2.6M), Binance USDCUSDT ($2.8B, secondary) | Deepest coverage, gold-standard reference |
| USDT | Coinbase USDT-USD ($25M), Kraken USDTUSD ($184M), Bitstamp usdtusd ($12M) | The no-key USD-quoted USDT markets with depth |
| FDUSD | Binance FDUSDUSDT ($41M, secondary only) | USDT-only depth; primary metric blank — that's honest |
| USDe | Binance USDEUSDT ($1.8M, secondary only) | The Oct 2025 depeg star; thin but watched |
| DAI | Curve 3pool get_dy, geometric mean of both directions (fee cancels) | All CEX DAI markets are dead in 2026 (re-checked 2026-07-08: Kraken DAIUSD ~$145k/24h, ~9 bps spread; Bitstamp zero volume; Coinbase delisted). On-chain is the only honest signal. |

## Source coverage matrix (live-validated 2026-05-20, DAI + Coinbase re-checked 2026-07-08)

| Stable | Binance | Coinbase | Kraken | Bitstamp | Curve | Coverage verdict |
|---|---|---|---|---|---|---|
| USDT | (quote only) | ✅ $25M | ✅ $184M | ✅ $12M | indirect via 3pool | strong |
| USDC | ✅ $2.8B (USDT) | 404 (not listed) | ✅ $63M | ✅ $2.6M | ✅ 3pool | strongest |
| DAI | dead | delisted | thin ($145k) | dead | ✅ 3pool | on-chain only |
| FDUSD | ✅ $41M (USDT) | - | - | - | - | USDT-only |
| USDe | ✅ $1.8M (USDT) | - | - | - | - | USDT-only |

V2 candidates (need a free signup): Alchemy/Defillama price feeds, Curve crvUSD/USDC pool (crvUSD), GHO/USDC pool (GHO), Curve PYUSD/USDC pool (PYUSD), Sky PSM (USDS direct).

## Endpoints

| Path | Purpose |
|---|---|
| `GET /metrics` | Prometheus exposition. Scraped by the OCB Prometheus. |
| `GET /health` | Plain `ok`. Railway probe. |
| `GET /` | Banner string. |

## Run locally

```bash
go run ./cmd/script
# metrics at http://localhost:2112/metrics
```

Optional env overrides — any source URL is overridable without a rebuild:

```bash
STABLE_URL_CURVE_RPC=https://your-private-eth-rpc.com \
STABLE_URL_BINANCE_USDC=https://api.binance.com/api/v3/ticker/bookTicker?symbol=USDCUSDT \
go run ./cmd/script
```

## PromQL recipes

```promql
# 24h median of per-minute worst deviation (the ledger sort key)
quantile_over_time(0.50, peg_deviation_worst_bps[24h])

# 24h p99, the depeg-tail column
quantile_over_time(0.99, peg_deviation_worst_bps[24h])

# Cross-venue p99 gap (the bench's unique angle)
quantile_over_time(0.99, peg_cross_venue_gap_bps[24h])

# Stables currently in active depeg event
peg_depeg_event_flag == 1

# Time spent outside ±50 bps over last 24h, in minutes
peg_time_outside_band_24h_seconds / 60

# Per-venue raw price chart (for the live dashboard)
peg_raw_price{stable="usdc"}
```

## Deployment

Standard OCB-miniapp shape - multi-stage Dockerfile, port 2112, internal-only on Railway, scraped by `openchainbench-monitoring/prometheus/prometheus.yml` via `stablecoin-peg.railway.internal:2112`.

## Methodology footnote (for the bench page)

> *This bench measures deviation from $1.00, the nominal peg each issuer advertises. It does not adjust for differences in redemption mechanics, collateral quality, or wrapper risk. A coin that trades at $0.999 looks identical to one that trades at $1.001 — both are 10 bps off peg. The primary metric uses USD-quoted venue samples only; USDT-quoted samples (e.g. Binance USDC/USDT) appear in a separate `usdt-anchored` metric so that USDT's own deviation doesn't contaminate every other stable's measurement.*

## Known limits

- **5 stables only in MVP** (USDC, USDT, FDUSD, USDe, DAI). Adding crvUSD/GHO/USDS/PYUSD is a v2 lift via more Curve pools.
- **Ethereum mainnet only** for the on-chain source. Per-chain split (USDC-base, USDC-arbitrum, etc.) is a v2 build.
- **Bridged variants** (USDC.e on Arbitrum, etc.) not included — they have a different risk profile (bridge inventory) and should never be rolled into the issuer's canonical metric.
- **Coinbase Exchange API** (`api.exchange.coinbase.com`): USDT-USD ticker works and is polled (added 2026-07). USDC-USD returns 404 (USDC is not a listed product; Coinbase treats it as USD-equivalent) and DAI-USD is delisted, so Coinbase contributes USDT only.
- **Liquidity weights are static** in config.go, sourced from a 2026-05-20 snapshot. Refresh quarterly or wire to a live $ vol fetcher.
- **Histogram precision**: tier boundaries hardcoded for [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000] bps. Sub-1-bps deviations all bucket together — acceptable for the leaderboard's `bps integer` granularity.
