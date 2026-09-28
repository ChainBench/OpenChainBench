# perp-liq-rate

Prometheus exporter for bench 208. Publishes, per perp venue and per asset,
liquidated notional over the trailing 24 hours divided by the **peak** open
interest over the same 24 hours, times 100. Polls every 5 minutes, serves
gauges on `:2112/metrics`.

## Venues

| Slug | Assets | Liquidation source | Ranks? (every measured row goes through the band in `plausibility.go`; shares below were measured 2026-09-27 and move) |
|---|---|---|---|
| `hyperliquid` | ETH BTC SOL | 0xArchive `/v1/hyperliquid/liquidations`, all liquidation types; no rate without the key | on the band |
| `lighter` | ETH BTC | Coinalyze hourly buckets, symbols `0.T` `1.T` | on the band |
| `aster` | ETH BTC SOL | Coinalyze hourly buckets, symbols `ETHUSDT.S` `BTCUSDT.S` `SOLUSDT.S` | on the band |
| `gmx` | ETH BTC | Subsquid `tradeActions`, `orderType` 7 | on the band |
| `dydx` | ETH BTC SOL | v4 indexer tape, `type == LIQUIDATED` | on the band |
| `paradex` | ETH BTC | public tape, `trade_type == LIQUIDATION` | on the band |
| `orderly` | ETH BTC SOL | `GET /v1/public/liquidated_positions`, matching leg only, `cost_position_transfer` USD | on the band |
| `nado` | ETH BTC | archive `market_snapshots`, delta of `cumulative_liquidation_amounts` (x18 USD), one aggregate figure | on the band |
| `gains` | ETH BTC | on-chain `LimitExecuted` logs, `orderType` LIQ_CLOSE (6), Arbitrum and Base; traded notional from the same scan (MarketExecuted, LimitExecuted, executed resizes) | on the band |
| `ostium` | ETH BTC | Ormi subgraph, `tradeEvents` type `LiquidationExecuted` | on the band |
| `aevo` | ETH BTC | none reachable | no |

Slugs match the site's perp venue registry (`src/lib/perp-stats.ts`), except
`gmx`, which every perp bench's harness publishes as `gmx` while the cohort
registry calls it `gmx-v2`; `PRODUCT_ALIASES` in `src/lib/providers.ts`
collapses both onto one product page.

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
| `RPC_ARBITRUM` | `https://arb1.arbitrum.io/rpc` | Arbitrum One JSON-RPC (gains) |
| `LISTEN_ADDR` | `:2112` | metrics listen address |
| `COINALYZE_API_KEY` | unset | required for the lighter and aster numerators |
| `OXARCHIVE_API_KEY` | unset | required for the Hyperliquid numerator; without it the row reads N/A, since the HLP vault fallback sees backstop liquidations only |

## Metrics

```
perp_liq_rate_24h_pct{venue,chain}
perp_liq_volume_24h_usd{venue,chain}
perp_liq_open_interest_usd{venue,chain}
perp_liq_open_interest_peak_24h_usd{venue,chain}
perp_liq_open_interest_avg_24h_usd{venue,chain}
perp_liq_venue_volume_24h_usd{venue,chain}
perp_liq_share_of_volume_pct{venue,chain}
perp_liq_largest_event_share_pct{venue,chain}
perp_liq_newest_event_age_seconds{venue,chain}
perp_liq_ranked{venue,chain}
perp_liq_warming_up{venue}
perp_liq_health{venue}
perp_liq_source_available{venue}
perp_liq_last_refresh_timestamp_seconds{venue}
perp_liq_fetch_errors_total{venue,chain,error_type}
perp_realized_vol_24h_pct{chain}
```

`error_type` values: `http_4xx`, `http_5xx`, `http_status`, `timeout`,
`decode`, `parse`, `unavailable`, `oi_zero`, `partial_window`, `other`.

## Semantics

- Each (venue, asset) pair holds a 24h window of liquidation notionals keyed
  by event identity, plus a 24h trail of open-interest readings. Both are
  pruned every tick. All pairs are polled in parallel per tick.
- **Events versus buckets.** An event source reports an immutable fact once,
  and `SeenSet` stops it being counted twice. A bucket source (Coinalyze)
  reports an hourly total that keeps growing while its hour is open, so its
  events carry `Bucket: true` and the runner *replaces* the value held for
  that key. Treating a bucket as an event froze every hour at the reading it
  had minutes after the hour began: Lighter published $887 against $185.6M
  of ETH volume until 2026-09-27 because of that. See the note at the top of
  `window.go`.
- **Open interest is the notional that could have been force-closed.** A
  book reports one side, since longs and shorts match and a liquidation of
  longs is measured against the longs that existed. The pool venues (GMX v2,
  Gains, Ostium) report long and short separately against their vault and
  the two are independent, so both count. Halving the pool figure, as this
  harness did until 2026-09-28, put the rate above 100% with no turnover on
  an unbalanced book, and left the rate on one convention while the share of
  volume was on another. See `poolOpenInterest` in `common.go`.
- **The denominator is the window's peak.** The numerator covers 24 hours,
  so dividing by an instantaneous open interest made the rate move with the
  denominator: Gains published 343% on 2026-09-24 because its open interest
  fell from $37M to $7.3M while its numerator stood still. The mean over the
  window was the first repair and still read 251% on 2026-09-28, when Gains
  ETH fell from $43.7M to $2.1M because most of the book was liquidated. The
  peak is the largest book the venue was observed holding; against it that
  day reads 62%. The mean is published beside it. Above 100% is turnover:
  positions opened after the peak reading, or opened and closed between two
  readings, count in the numerator and never enter the denominator.
- **The rate waits for the denominator.** `perp_liq_rate_24h_pct` and the
  peak are published only once a row holds 12 open-interest readings (an
  hour), so a restart does not put a 24h numerator over one reading.
  `perp_liq_warming_up{venue}` is 1 for exactly that hour.
- **The rank gate** lives in `plausibility.go`. A row ranks only when it has
  a feed, the tick succeeded, no page cap left part of the window unread,
  the denominator has at least 12 readings, at least $10,000 was
  liquidated, no single liquidation is more than half of the figure (rows
  with event detail), the venue publishes a 24h notional, and liquidated
  notional is between 0.01% and 3% of that notional. Every other case
  publishes its figures with `perp_liq_ranked = 0`, and the harness logs the
  reason by name. The band exists because the venues do not agree on what a
  liquidation is: measured on 2026-09-27, Hyperliquid read 0.17% of its own
  BTC volume and 0.005% on ETH off a short feed, Aster 0.18%, Lighter 0.024%,
  dYdX 0.00085% and Gains 14.9% of venue-level volume. The size gates exist
  because on 2026-09-28 Ostium BTC sat inside the band on $338 from one
  event, above Hyperliquid.
- **Page caps hand over what they read.** The tapes that page newest first
  (dYdX, Paradex, Orderly, Ostium, the GMX squid) return the rows read plus
  a `partialWindowError` naming the oldest row reached. The runner folds the
  rows in, counts `partial_window`, advances the high-water mark so the next
  request fits, and holds the rank until the unread edge has aged out of the
  window. 0xArchive keeps the refusal (its cap is 29x a busy BTC day).
- On a fetch error the previously published gauges are kept,
  `perp_liq_fetch_errors_total` is incremented and the error is logged;
  `perp_liq_health{venue}` drops to 0 for the tick.
- `lighter`: HTTP 404/501 marks the venue unavailable (health 0). After 3
  consecutive unavailable ticks it logs once and suppresses further error
  increments until recovery.
- `gains`: a minimal Keccak-256 is embedded (the only external dependency
  allowed is the Prometheus client) and covered by known-vector tests. The
  decode is self-checking: the event encodes position size twice, as
  `collateralAmount x leverage` and as `positionSizeToken x openPrice`, and a
  log whose two encodings differ by more than 5% is refused rather than
  published. `source_gains_golden_test.go` and `source_gains_volume_test.go`
  pin the word offsets and the topic hashes against five real Arbitrum logs.
  One scan per deployment per tick reads `LimitExecuted`, `MarketExecuted`,
  `PositionSizeIncreaseExecuted` and `PositionSizeDecreaseExecuted` from a
  block cursor; liquidations are the LIQ_CLOSE legs, traded notional is
  every leg of the pair (resizes at `positionSizeCollateralDelta`), which is
  the Gains backend's own auto-plus-direct perimeter. Logs are placed on the
  clock by interpolating between the headers at both ends of the range.
  `go test -tags live -run TestLive_GainsVolume` prints the scan next to the
  backend's volume-mix, and `TestLive_GainsVolumeAudit` (with
  `GAINS_FROM_BLOCK` / `GAINS_TO_BLOCK`, optionally `GAINS_CHAIN=base`) lists
  every leg of a fixed block range grouped by pair and fails on a key counted
  twice.
- **The Gains perimeter is Arbitrum plus Base**, and all three of its figures
  are read on it: liquidations, open interest and traded notional. So the row
  is internally consistent and smaller than the venue as a whole, which also
  trades on Polygon, MegaETH and ApeChain. Audited over the complete UTC day
  2026-09-27: $26,267,342 on Arbitrum (BTC $15.08M, ETH $1.92M) plus
  $1,075,396 on Base, against the Gains backend's $34,760,896 across every
  chain, so 79% of the venue with no duplicate keys. Comparing this row with
  a venue-level figure from elsewhere needs the same day as well as the same
  chains: the venue's own backend reports $34.8M for 2026-09-27 and $210.8M
  for 2026-09-28, a cascade day.

## Venues checked and not added

- **Pacifica** (`cause` on the public tape) and **Extended** (`tT`): the flag
  is real and verified, but the public tape reaches back only minutes (40
  and 50 rows, no time range; Extended documents historical trades as
  auth-only). **Backpack** publishes a `liquidation.<symbol>` websocket
  stream with no REST form. All three need a persistent collector.
- **ApeX Omni, GRVT, Vest, StandX**: no liquidation signal on any public
  endpoint; where a flag exists it is per-account behind authentication.

- **edgeX**: the live v2 deployment publishes no public trade tape. Every
  trades and liquidation path 404s, and the only reachable websocket gateway
  serves the retired v1 contract ids.
- **Jupiter Perps**: `/v1/trades` requires a wallet address and its `action`
  enum has no liquidation value, so no venue-level feed exists short of
  decoding the program on Solana.
- **Drift**: now Velocity, on a fresh program deployment. `/stats/liquidations`
  works and needs no key, but its ETH and BTC books held single-digit
  thousands of dollars on 2026-09-27 with zero liquidations ever recorded on
  ETH, so a per-asset rate would be noise. The cohort registry parks Drift
  for the same reason.
