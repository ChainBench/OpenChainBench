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
| `gmx` | ETH BTC | Subsquid `tradeActions`, `orderType` 7; carries the position, so the forfeited share too | on the band |
| `dydx` | ETH BTC SOL | v4 indexer tape, `type == LIQUIDATED` | on the band |
| `paradex` | ETH BTC | public tape, `trade_type == LIQUIDATION` | on the band |
| `orderly` | ETH BTC SOL | `GET /v1/public/liquidated_positions`, matching leg only, `cost_position_transfer` USD | on the band |
| `nado` | ETH BTC | archive `market_snapshots`, delta of `cumulative_liquidation_amounts` (x18 USD), one aggregate figure | on the band |
| `gains` | ETH BTC | on-chain `LimitExecuted` logs, `orderType` LIQ_CLOSE (6), Arbitrum and Base; traded notional from the same scan (MarketExecuted, LimitExecuted, executed resizes); carries the position, so the forfeited share too | on the band |
| `ostium` | ETH BTC | Ormi subgraph, `tradeEvents` type `LiquidationExecuted`; carries the position, so the forfeited share too | on the band |
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
| `STATE_PATH` | `/state/perp-liq-windows.json` | where the 24h windows are kept across restarts; set empty to disable |
| `COINALYZE_API_KEY` | unset | required for the lighter and aster numerators |
| `OXARCHIVE_API_KEY` | unset | required for the Hyperliquid numerator; without it the row reads N/A, since the HLP vault fallback sees backstop liquidations only |

## Metrics

```
perp_liq_rate_24h_pct{venue,chain}
perp_liq_volume_24h_usd{venue,chain}
perp_liq_open_interest_usd{venue,chain}
perp_liq_open_interest_peak_24h_usd{venue,chain}
perp_liq_open_interest_trough_24h_usd{venue,chain}
perp_liq_open_interest_avg_24h_usd{venue,chain}
perp_liq_collateral_forfeited_pct{venue,chain}
perp_liq_loss_at_trigger_pct{venue,chain}
perp_liq_collateral_returned_pct{venue,chain}
perp_liq_forfeit_events{venue,chain}
perp_liq_collateral_forfeited_by_leverage_pct{venue,chain,band}
perp_liq_liquidations_by_leverage_count{venue,chain,band}
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
`decode`, `parse`, `unavailable`, `oi_zero`, `partial_window`,
`oi_head_mismatch`, `other`.

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
- **Gains' open interest is read off the chain, so it needs no warm-up.** The
  diamond emits `PairOiAfterV10Updated` on every open and close carrying the
  *post-state* book per collateral, so one pass of the same scan gives the
  whole curve at every change. Reconstruction: keep the latest (long, short)
  per collateral index and sum `(long + short) / 10^decimals x
  collateralPriceUsd`, which is `FetchOI` exactly. Seeding is exact without a
  walk-back: a collateral with events in the window takes its pre-window state
  from the first of them (undo the delta on whichever leg `w3` names), and a
  collateral with *no* event cannot have changed, so its head value is its
  value throughout. Quantities are historical and so are the prices, taken
  from the `collateralPriceUsd` the contract stamps on its own execution
  events, nearest at or before each reading.

  Validated against the venue's API and against an independently written
  reconstruction, over 2026-09-28:

  | | peak | trough | head vs live |
  |---|---|---|---|
  | ETH | $43,541,865 | $2,632,507 | -0.008% |
  | BTC | $49,941,650 | $1,124,220 | -0.002% |

  The accumulated window had been reading $2.72M on ETH and $10.79M on BTC,
  because every sample it held was taken after the cascade. That is the
  difference between publishing 952% and 63% on ETH, and 211% and 25% on BTC.
  `checkOIHead` compares the reconstruction against the live book every tick
  and counts `oi_head_mismatch` past 1%.
- **What a forced close costs the trader, where the feed says.** The rate
  above is notional and so it is leverage-sensitive; it cannot answer "how much
  of my money would I lose". Three quantities per forced close can. The margin
  behind the position; the share of that margin the price had already taken when
  the venue closed it (`perp_liq_loss_at_trigger_pct`); and the share that went
  back to the trader (`perp_liq_collateral_returned_pct`). What is left is
  `perp_liq_collateral_forfeited_pct`, the margin destroyed *in excess of the
  loss the trader actually incurred*, computed per close and then published as
  the median of those, so it is **not** 100 minus the two medians beside it.
  All three are medians over the same 24h window, taken independently, with
  `perp_liq_forfeit_events` saying how many closes are behind them,
  and `perp_liq_collateral_forfeited_by_leverage_pct` breaking the forfeit out
  by leverage band beside its own count.

  On the first deploy the three shares fill in over a day rather than at once.
  A state file written before this change carries no forfeit detail, so the
  liquidations restored from it come back with `HasForfeit` false and only the
  closes read after the deploy count. Nothing is wrong and nothing needs doing:
  `perp_liq_forfeit_events` climbs to the full window within 24h. The
  liquidation and open-interest windows themselves restore as before.

  Two blanks, told apart. A venue that can read the position and saw no forced
  close in the window publishes `perp_liq_forfeit_events = 0` with no medians;
  a venue whose feed cannot read the position publishes no series at all, count
  included (`positionSource` in `common.go`). Ostium is regularly the first
  case: one BTC liquidation in the 24h to 2026-09-29, none on ETH or SOL.

  Three of the eleven venues carry all three quantities. Measured 2026-09-29:

  | venue | window | n | margin | returned, median | loss at trigger, median | forfeited, median |
  |---|---|---|---|---|---|---|
  | gains, all pairs, Arbitrum | 3 d | 886 | $865,543 | 0.00% | 60.0% | **40.0 pts** |
  | gmx, all markets | 24 h | 187 | $43,013 | 18.60% | 63.3% | **15.4 pts** |
  | ostium, all pairs | 7 d | 91 | $16,984 | 0.00% | 79.2% | **20.8 pts** |

  Every figure in the last three columns is a **median over the closes**, and
  the three are taken independently, so they do not add to 100: on the GMX row,
  `100 - 63.3 - 18.60` is 18.1 and the median forfeit is 15.4. The subtraction
  happens per close, in `windowEntry.forfeit()`, and a median is not linear.
  Aggregate shares, for the same three windows, are a different statistic and
  read $0 of $865,543 returned on Gains, $4,827 of $42,980 (11.2%) on GMX and
  $0 of $16,984 on Ostium.

  By leverage band on the Gains window: 0-10x n=64 forfeit 26.3 pts, 10-25x
  n=120 29.3, 25-50x n=112 31.8, 50-100x n=191 41.6, 100x+ n=399 40.9. The
  forfeit *grows* with leverage, because a position opened at 100x is closed
  after a smaller move and so less of its margin has gone to the price by the
  time the venue takes the rest. That is the single most useful line here for a
  trader picking a leverage.

  Where the quantities come from, and what was checked against the chain rather
  than against this harness:

  - `gains`: `percentProfit` (w28 of `LimitExecuted`, **int256 and signed**,
    1e10 fixed point percent) and `amountSentToTrader` (w29, the collateral's
    own decimals). percentProfit is the price move times the leverage and
    nothing else: `(liqPrice - openPrice) / openPrice x leverage`, signed by
    `t.long`, reproduces it on 120 of 120 real liquidations. In tx
    `0x427c242f` a 200,228 dollar ETH position at 108.213x closed 51.24% down,
    and the transaction's three USDC transfers total the whole margin with every
    one going to the vault at `0xd3443ee1`, none to the trader: that trader
    forfeited 48.76 points, 97,631 dollars. `source_gains_forfeit_test.go` pins
    the log word for word.
  - `gmx`: `initialCollateralDeltaAmount` x `collateralTokenPriceMin` / 1e30 is
    the margin (GMX quotes per smallest unit at 1e30, so no token decimals are
    needed); `basePnlUsd` is the price P&L; `pnlUsd` is the same all in, and
    margin plus `pnlUsd` is the residual paid out. In tx `0xee583c74` that
    computes 8.6551 USDC and the transaction transferred 8.655363 to the
    liquidated account. Of the twelve largest liquidations that day, seven
    matched an on-chain transfer of exactly the predicted amount and five were
    cross-chain orders paid to a GMX vault for the same amount. The volume query
    deliberately keeps a narrower field list (`gmxFieldsSize`): asking every
    executed order of a busy day for four more BigInt fields is how the squid's
    "response might exceed the size limit" refusal would arrive, and a refused
    volume read unranks both GMX rows.
  - `ostium`: `profitPercent` (1e6 fixed point, signed), `amountSentToTrader`
    (6-decimal USD) and the linked trade's `collateral` and `leverage`. Its
    leverage is **1e2** fixed point, not the 1e3 Gains uses: a row reading 5000
    is 50x, and `trade.notional / trade.collateral` confirms it. The event's own
    `collateralDelta`, `leverage` and `notional` are all null on a liquidation.
    In tx `0xfa67b49b` the two USDC legs total the margin and both go to the
    vault, so the zero payout is the truth and not an unread field.

  Three refusals and one clamp, all of them measured rather than defensive:

  - A forced close whose **price return was positive** does not enter the
    arithmetic on any of the three venues. Ten of the 886 Gains liquidations
    were like that, the largest a long on pair 482 up 8.88% at 52.88x closed as
    `LIQ_CLOSE` with nothing returned. The word is read correctly and the event
    is not a trader losing money to a move; left in, each would have contributed
    a forfeited share of 569 points. The row keeps its notional.
  - A row with **no margin figure** publishes its notional and nothing here.
  - A loss above 100% of margin **forfeits nothing** and publishes 0 rather than
    a negative share that would read as money handed back. Ostium had one such
    row in 91 over 7 days, at 116%; the venue absorbed the excess.
  - The medians are medians, not aggregate ratios. One 200,228 dollar position
    beside a hundred small ones would otherwise be a venue's whole answer.

  **What the forfeited share contains.** All three venues define their loss
  figure as price only, so the forfeit is the closing fee, the liquidation
  penalty, and the funding and rollover accrued while the position was open.
  Those are real costs the trader did incur, so it is the margin lost to
  something other than the move, not a penalty. Gains shows the distinction
  itself: its 602 stop losses over the same three days returned 75.2% of
  154,420 dollars at a median loss at trigger of 24.3%, while its liquidations
  returned nothing. (Twelve of those 602 stop losses returned zero too, so a
  zero payout is not by itself the signature of a liquidation.)

  **The eight venues that cannot report it, checked one record at a time on
  2026-09-29 rather than assumed. Seven have a liquidation feed with no position
  in it; Aevo has no liquidation feed at all.** Hyperliquid's 0xArchive row carries `coin`,
  `timestamp`, `liquidated_user`, `price`, `size`, `side`, `mark_price`,
  `closed_pnl` and `direction`: the realized P&L in dollars with no margin to
  divide it by, and cross-margin at the account rather than the position.
  Orderly comes closest and still cannot: `collateral_value` is the equity
  remaining at the instant of liquidation (it equals `margin_ratio` x
  `position_notional` exactly), not the margin posted, and `abs_liquidation_fee`
  plus `abs_insurance_fund_fee` routinely exceeds it, so there is a numerator
  and no denominator. dYdX's tape carries `id, side, size, price, type,
  createdAt, createdAtHeight`; Paradex's carries `id, market, side, size, price,
  created_at, trade_type` (and 12,000 BTC rows over 3.5 days held no LIQUIDATION
  at all, only FILL and RPI). Lighter and Aster arrive as Coinalyze hourly
  buckets of `{t, l, s}` in base units, with no positions inside them; Lighter's
  own `/api/v1/liquidations` requires an `account_index` and Aster's
  `allForceOrders` answers that it is out of maintenance. Nado's snapshot path
  is one cumulative counter per product, and its `liquidate_subaccount` events
  carry the perp balance and the venue's risk weights but no subaccount
  collateral. Those eight rows publish **no series at all** on these gauges,
  which is the whole point: a 0.0% would read as a venue that forfeits none of
  its traders' margin and would sit at the top of the column.

  **Not comparable across the kinds of feed, and the spec says so.** An event
  feed reports positions; an hourly bucket reports a total. Lighter and Aster
  already read a largest-event share of 0.0% purely because their feed holds no
  events, and the same asymmetry applies here in its strongest form: they cannot
  appear in this measurement at all, so the three venues that can are published
  as annotations beside the ranked notional rate rather than as a ranked column.

- **The mean is time-weighted**, not averaged over readings. Event density is
  wildly uneven: Gains ETH had 67 open-interest events across all of
  2026-09-27 and 88 in the single hour it collapsed, so an average over
  readings reports the collapse as the day's normal state. Each reading is
  weighted by how long it stood. For the venues still sampled on a timer the
  two agree.
- **The trough publishes beside the peak** (`perp_liq_open_interest_trough_24h_usd`),
  because a book that ran from $49.94M to $1.12M and back to $10.65M inside
  one day is two markets and the peak alone hides that.
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
- **The windows survive a restart.** Both the open-interest sample window and
  the liquidation window are kept in a JSON file (`STATE_PATH`, default
  `/state/perp-liq-windows.json`) written after every tick and read on boot,
  the shape `harnesses/protocol-valuation` uses for its fee-basis memory.
  Open interest is the one input no source can backfill: a venue publishes
  the book it holds now, never the book it held this morning. Without this a
  redeploy divided a full 24h of liquidations by the peak of the minutes
  since boot, and on 2026-09-28 Gains ETH published **952%** against a peak
  of $2.9M when the book had actually held $43.7M inside the window.
  Restored liquidation keys go back into the `SeenSet`, so a source that
  re-reports them cannot double count. An unset or unwritable path is a
  degraded mode, logged once, not a failure.
  Deploying: the image runs as `perpliq` (uid 1000), so the mounted volume
  has to be writable by it. `docker run ... -v /data/state/perp-liq:/state`
  plus `chown 1000:1000` on the host directory; a root-owned volume logs
  `[oi-state] cannot write ... permission denied` once and the harness runs
  on without persistence, which is the mode this replaces rather than a
  crash.
- **A refused row can lose its rate, not just its rank.** An unranked row
  still renders its headline figure, so `rateIsMeaningful` in
  `plausibility.go` deletes `perp_liq_rate_24h_pct` when the reason means the
  ratio describes nothing: `single_event_is_the_window`,
  `no_volume_denominator`, `oi_window_shorter_than_numerator`,
  `window_read_short`, a failed read, or warm-up. Every input still
  publishes; only the ratio is withheld. `no_liquidations_observed` keeps its
  honest zero.
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
  `go test -tags live -run TestLive_ForfeitedCollateral` prints the three shares
  and the leverage bands for every venue, and says "none" for the eight whose
  feed carries no position (`LIQ_LOOKBACK_HOURS` widens the window past 24h for
  the venues that liquidate a handful of positions a week).
  `go test -tags live -run TestLive_GainsVolume` prints the scan next to the
  backend's volume-mix, and `TestLive_GainsVolumeAudit` (with
  `GAINS_FROM_BLOCK` / `GAINS_TO_BLOCK`, optionally `GAINS_CHAIN=base`) lists
  every leg of a fixed block range grouped by pair, fails on any key counted
  twice anywhere in the window, and prints both endpoint header timestamps so
  the window a figure describes is on the record rather than inferred from a
  nominal block time.
- **The Gains perimeter is Arbitrum plus Base**, and all three of its figures
  are read on it: liquidations, open interest and traded notional. So the row
  is internally consistent and smaller than the venue as a whole, which also
  trades on Polygon, MegaETH and ApeChain. Audited over the complete UTC day
  2026-09-27 (both ranges verified at 24.00 h from their endpoint headers):
  $26,267,342 on Arbitrum across 88 pairs and $1,075,396 on Base across 74,
  against the Gains backend's $34,760,896 for every chain, so 79% of the
  venue, with no key counted twice in either window. Per asset, summing both
  deployments: BTC $15,125,974 and ETH $1,941,932; on Arbitrum alone BTC is
  57.4% of the day and ETH 7.3%. Comparing this row with
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
