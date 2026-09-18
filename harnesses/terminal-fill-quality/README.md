# terminal-fill-quality

What a swap costs the user on each Solana trading terminal / Telegram bot,
measured on-chain. Feeds bench 268 (`terminal-fill-quality`), the
`/trading-apps` hub and the "Trading app" view on `/products/<slug>`.

Method version 3 (`methodVersion` in `config.go`). Every sampled swap
carries it; statistics only use rows of the running version, and rows of
an older one are dropped at load, so a method change never mixes two
accountings inside the window.

## Method

Every terminal takes its fee through known wallets (DeFiLlama's dexs /
fees adapters and Dune's spellbook, so attribution matches benches 201
and 267). A WebSocket `logsSubscribe` on each of those wallets (and on
pump.fun's app program) delivers every transaction the terminal routes,
within a second of confirmation, with its error status and program logs.
The logs say whether a swap program was invoked (`swapProgramPrefixes`:
venues, Jupiter, the terminals' routers): only those are swap attempts;
wallet funding, fee sweeps and GMGN's 1-lamport markers are counted apart
and never enter the fail rate. Each tick draws `DAILY_TARGET × tick /
86400` of the tick's successful attempts per terminal at random
(reservoir sample, weighted by the tick's activity so bursts are
represented in proportion to their trades) and reads them with
`getTransaction`. When the feed is down the harness polls the wallets
instead (`WS=0` forces polling; without logs every signature counts as an
attempt).

A Solana transaction carries the pre/post SOL and token balances of every
account it touches and the account list of every instruction, so each
sampled swap is reduced to exact quote-side amounts (SOL or a $1 stable),
see `parse.go`:

| Field | Meaning |
|---|---|
| `user_q` | what left (buy) or reached (sell) the user's quote balance; the tx fee is inside when the user paid it; rent of token accounts created / closed and of program accounts the user funded (pump.fun's volume accumulator) excluded; a created WSOL account counts only its rent, the token delta carries the wrapped amount |
| `pool_q` | what the pool(s) received / paid out, over the pool's own vaults |
| `terminal_q` | what landed in the terminal's fee wallets (lamports, WSOL or a stable, converted to the quote unit); FOMO: plus its user-signed USDC legs to per-trade accounts outside every pool instruction, bounded at 2 % of the trade |
| `network_q` | tx fee when the user is the fee payer (0 when the terminal sponsors gas, FOMO) + inclusion tips: Jito, 0slot, bloXroute, Astralane, Nozomi and each terminal's own relay accounts (`Terminal.Tips`: Axiom, Trojan, Maestro `BBtip…`, Photon, Pepeboost, pump.fun app `pfn…`) |
| `other_q` | `user_q − pool_q − terminal_q − network_q` on single-pool swaps without hops: pump.fun protocol / creator fees, referral payouts; exact, since the tx fee is no longer added back |

**Pool identity.** The pool is the token vault that moved against the
user plus the quote vault(s) of the same swap instruction with the same
owner, all by pubkey (`pool_vault`, `pool_quote_vaults`). Two pools behind
one shared authority (Raydium v4 `5Q544fKr…`, CPMM `GpMZbSM2…`, Launchpad
`WLHv2UAZ…`, Meteora DAMM v2 `HLnpSz9h…`) never merge into one, which was
the source of phantom 9,990 bps rows in version 2. Venue instructions of
the route that touch no token counterparty but move someone's token
account are hops (`hops`); Anchor's event self-CPI moves nothing and is
not one. A final pool quoted in a third asset (FOMO: USDC → NEAR / INJ /
USO → token) is priced through the route's own hop (`x_mint`, `x_rate` =
quote paid into the hop pools / X they paid out).

The token leg is valued at an **arrival price**, in this order:

1. `ref_src: reserves`: the pool's exact mid before the swap, from the
   pool's pre-trade balances in the transaction, when the route is one
   constant-product pool without hops. PumpSwap pools migrated from
   pump.fun carry a virtual quote reserve (about 17.58 SOL, stored at byte
   245 of the pool account, read once per pool); x·y = k holds exactly
   with it and fails without. Raydium v4 / CPMM: vault ratio.
2. `ref_src: reserves` too, from the venue's own swap event when it
   carries the state before the trade (`events.go`): Raydium Launchpad's
   `TradeEvent` (log `Program data:`) gives the virtual and real reserves
   before, the curve's mid is (virtual_quote + real_quote_before) /
   (virtual_base − real_base_before); Meteora DLMM's `Swap` event (an
   `emit_cpi` inner instruction: event-CPI discriminator + event) gives
   `start_bin_id`, a bin being the constant price (1 + bin_step /
   1e4)^bin_id read once per pair. Each is accepted only when it
   reconciles with the transaction (Launchpad: `real_base_after −
   real_base_before` = the vault delta to the raw unit; DLMM: the event's
   token amount = the vault delta and the executed price within 30 % of
   the start bin), so a layout mistake can never price a swap.
3. `ref_src: pool`: the effective price of the previous trade on the same
   pool (`getSignaturesForAddress` on the pool's token vault, `before` our
   signature; `ref_age_s` = seconds earlier, at most 60). Used for the
   pump.fun curve (its stored virtual reserves no longer predict the
   executed price on 2026 curves: real trades fill 20 to 60 % above
   virtual_sol / virtual_token), CLMM, DBC and routed swaps. It carries
   the previous trader's direction, so terminals priced mostly this way
   read some tens of bps worse in buy waves.
4. Nothing else. Swaps with neither keep their exact components and stay
   out of the loss figure; `ref_src_pct` says how many were priced and how.
   Jupiter's price API was tried and dropped (29 % negative losses).

```
buy : loss = 1 − tokens × ref / user_q
sell: loss = 1 − user_q / (tokens × ref)
```

`loss_bps` is the whole shortfall the user suffered against that
reference; `terminal_bps` / `network_bps` are exact; `other_bps` is known
on single-pool swaps without hops; `pool_bps` = loss − terminal − network
− other, i.e. LP fee + price impact, plus the hop costs and unattributed
fees on routed swaps. The four components always sum to the loss. All in
basis points of the trade (buy: quote spent; sell: tokens × ref; unpriced
sell: the larger of pool_q and what the user got back plus fees). Losses
outside [−1000, 5000] bps are parsing or reference errors: the row keeps
its figures with `flag: out_of_bounds` and stays out of the statistics.

Each terminal's `other_top` (largest "other" recipients over the window,
single-pool swaps, pump.fun's protocol fee recipients labelled) is in the
JSON so new fee or tip accounts can be spotted and classified.

**Fail rate** (`fail_rate_pct`): failed over every swap attempt the feed
saw, exhaustive; `fail_reasons` keeps the top error classes (pump.fun
`Custom:6002/6003` = slippage, `Custom:1` insufficient lamports, Jupiter
`Custom:6001`…). A failed swap still costs its fee: `FAIL_DAILY_TARGET`
(40) failed attempts per terminal per day are read for it (a failed
transaction executes nothing, so only base + priority fee is paid, zero
when the terminal sponsors gas), giving `fail_cost_usd` (median) and
`fail_overhead_bps` = fail rate / (1 − fail rate) × median failed fee, in
bps of the median trade: the burn a successful swap carries on average.
Published apart (`tfq_fail_cost_usd`, `tfq_fail_overhead_bps`), not added
to the cost per swap.

**User detection**: the signer whose token balance moved (largest
non-quote move). When nobody signed for the user, a keeper-executed order
(limit, DCA, auto-sell: the terminal's keeper signs and the user's token
account moves), the user is the on-curve owner (a wallet, never a
program-derived pool address, checked on the ed25519 curve) whose token
account moved against its SOL / stable balance. Quote assets: SOL, USDC,
USDT, USD1, USDS, PYUSD.

**Sandwiches**: a sandwich's front-run and back-run both touch the pool,
so they are the swap's neighbours in the pool vault's signature sequence:
`before` our signature for the previous trades (read anyway for the
reference), `until` our signature for the ones after (a 100-entry page,
then 1,000 on very busy pools; unknown beyond). It counts when another
signer (never the user) traded our direction in our slot just before us
and back in our slot or the next, closing a comparable position (0.5 to
2× the tokens) with a positive take. Kept per swap (`sandwich`: attacker,
front and back signatures, profit in bps of the victim's trade) and
summarised per terminal (`scanned`, `sandwiched`, `sandwich_pct`), but not
published as a ranking column: the share of swaps that can be screened
depends on pool activity. The victim's extra cost is already inside
`loss_bps` (the front-run precedes us, so it is in the arrival price).

**Trade-size buckets**: `by_size` per terminal (under $25, $25 to $250,
over $250; median loss and n from 5 samples).

**Cross-chain (`xchain.go`)**: FOMO's and BasedBot's users pay on BNB,
Robinhood Chain, Base, Ethereum or Arc and Relay delivers on Solana;
nothing on Solana pays the app's fee wallet, so the WebSocket feed never
sees these. Relay's public requests feed (`/requests/v2?originChainId=`,
no key; the `referrer` filter works for BasedBot, FOMO's referrer is
private but its fee address `0x9fc4e320…` is in every request's
`appFees`) is polled every tick per origin chain until a known id: every
final request is counted (`success` vs `refund` / `failure` for the fail
rate) and successful ones go to a reservoir. A sampled request is read
on Solana (`outTxs`): when it delivered USDC / SOL (FOMO's case: the
wallet is funded, the token buy is a native swap in the FOMO row) the
value received is exact and the row is a bridge leg (venue `relay`,
`pool` 0): value given = `currencyIn.amountUsd` + origin gas (receipt on
the chain's public RPC, priced with Coinbase ETH / BNB), terminal = the
app fee the user paid (`feeSponsorship` user-pays when present, else the
quoted `appFees`), relay = deposit − received − app fee (Relay's fees and
spread), network = origin gas. When it delivered a token, the settlement
is parsed as a native swap with the recipient as user and priced at the
pool's state before it. Requests paid with a token on the origin chain
are flagged `origin_token` and kept out of the statistics (value in is
Relay's valuation). `chain`, `relay_bps`, `relay_id`, `in_tx` per row,
`by_chain` and `components_bps.relay` per app, `tfq_loss_bps_chain`.

**Publication thresholds**: `healthy` (figure published, `tfq_health`)
from `MIN_PRICED` = 50 priced swaps in the window; `ranked` (`tfq_ranked`)
from `MIN_RANK` = 100. `loss_bps` carries the median's 95 % bootstrap
interval (`ci_lo`, `ci_hi`, 300 resamples) so a gap between two terminals
can be read against the sampling noise; the JSON orders ranked terminals
by median, then published-but-not-ranked, then the rest.

## Cohort

Axiom (22 wallets: 20 fee wallets plus the two second-leg recipients of
its 1 %), GMGN (9), FOMO (fee wallet + gas sponsor excluded as user, USDC
fee legs), Photon, Trojan (6), Bloom, Maestro, Pepeboost, BONKbot, Banana
Gun (fee wallet + its Solana router program), Terminal (formerly Padre:
protocol + cashback wallets), pump.fun's mobile app (by its app program).
Wallet lists come from DeFiLlama's adapters and Dune's spellbook
(`dex_solana.bot_trades` platform models), checked live on 2026-09-18. Not in: BullX (trading
suspended 2026-06-01, its wallets only see 1,000-lamport markers), Nova
(no live fee wallet), BasedBot (DeFiLlama's `basedbid` addresses belong to
a launchpad / bid mechanism; the bot's fee wallet is not published).

## Outputs

Prometheus on `:2112/metrics`, rolling `WINDOW_HOURS`:

| Gauge | Labels | Meaning |
|---|---|---|
| `tfq_loss_bps` | terminal, stat=median/p90/ci_lo/ci_hi | loss vs the pool's pre-trade state, priced samples; only when healthy |
| `tfq_component_bps` | terminal, component=terminal/network/other/pool | median per component |
| `tfq_fail_rate_pct` | terminal | failed / swap attempts, percent |
| `tfq_sample_size` | terminal, kind=seen/parsed/priced | seen = swap attempts |
| `tfq_trade_usd` | terminal, stat=median/p90 | |
| `tfq_venue_share_pct` | terminal, venue | |
| `tfq_buy_share_pct` | terminal | |
| `tfq_sandwich_pct`, `tfq_sandwich_profit_bps` | terminal | informative, see above |
| `tfq_loss_bps_size` | terminal, bucket | median loss by trade-size bucket |
| `tfq_health`, `tfq_ranked` | terminal | priced ≥ `MIN_PRICED` / ≥ `MIN_RANK` |
| `tfq_feed_up`, `tfq_sol_usd`, `tfq_last_refresh_unix`, `tfq_rpc_calls_total`, `tfq_rpc_errors_total` | | |

JSON on `:2112/v1/fills` and mirrored to `HISTORY_FILE_PUBLIC`: per-terminal
stats plus the last 400 samples (`method_version`, `min_priced`,
`min_rank` at the top).

## Env

| Var | Default | Meaning |
|---|---|---|
| `HELIUS_API_KEY` / `SOLANA_RPC` | public RPC | RPC endpoint for the reads |
| `RPC_RPS` | `8` | pacing, calls per second |
| `TICK_SECONDS` | `60` | sweep interval |
| `DAILY_TARGET` | `300` | swaps read per terminal per day (random draw from the feed) |
| `WS` | `1` | live feed via logsSubscribe; `0` = poll the wallets |
| `WS_URL` | RPC URL | feed endpoint when different from the reads (the keyless public `wss://api.mainnet-beta.solana.com` works) |
| `WINDOW_HOURS` | `24` | rolling window |
| `MIN_PRICED` | `50` | priced samples before a terminal is published |
| `MIN_RANK` | `100` | priced samples before a terminal is ranked |
| `MIN_TRADE_USD` | `2` | dust threshold |
| `STATE_FILE` | unset | persist the window across restarts |
| `HISTORY_FILE_PUBLIC` | unset | public JSON mirror |

Budget: about 4 to 5 RPC calls per sampled swap (transaction, two
signature pages on the pool vault, previous trade when the reserves give
no mid, pool account once per pool, back-run only on a sandwich
candidate) and no polling, so 300 swaps × 11 terminals ≈ 15k calls a day.
Fits Helius's free tier; WebSocket notifications on the public endpoint
are not metered.

```bash
docker build -t ocb-terminal-fill-quality .
docker run -d --name ocb-terminal-fill-quality --network ocb_web --restart unless-stopped \
  -v /data/state/aggregate/terminal-fills:/data/public -v /data/state/terminal-fills:/data/state \
  -e HELIUS_API_KEY=… -e WS_URL=wss://api.mainnet-beta.solana.com \
  -e STATE_FILE=/data/state/state.json -e HISTORY_FILE_PUBLIC=/data/public/fills.json \
  ocb-terminal-fill-quality
```
