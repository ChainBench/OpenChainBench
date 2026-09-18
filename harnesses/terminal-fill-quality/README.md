# terminal-fill-quality

What a swap costs the user on each Solana trading terminal / Telegram bot,
measured on-chain. Feeds bench 268 (`terminal-fill-quality`), the
`/trading-apps` hub and the "Trading app" view on `/products/<slug>`.

## Method

Every terminal takes its fee through known wallets (the lists DeFiLlama's
dexs / fees adapters match on, so attribution is identical to benches 201
and 267). `getSignaturesForAddress` on those wallets yields every
transaction the terminal routed, failed ones included; the newest
successful ones are read with `getTransaction` (`SAMPLE_PER_TICK` per
terminal per tick).

A Solana transaction carries the pre/post SOL and token balances of every
account it touches, so each sampled swap is reduced to exact quote-side
amounts (SOL or a $1 stable), see `parse.go`:

| Field | Meaning |
|---|---|
| `user_q` | what left (buy) or reached (sell) the user's quote balance, rent for new token accounts excluded, tx fee excluded |
| `pool_q` | what the pool(s) received / paid out; 0 when a multi-hop route hides the quote leg |
| `terminal_q` | what landed in the terminal's fee wallets (lamports, WSOL or a stable, converted to the quote unit) |
| `network_q` | tx fee when the user is the fee payer (0 when the terminal sponsors gas, FOMO) + Jito tips |
| `other_q` | quote that left the user and reached neither pool, terminal nor network: pump.fun protocol / creator fees, referral payouts, hop costs |

The token leg is valued at an **arrival price**, in this order:

1. `ref_src: reserves`: the pool's exact mid before the swap, from the
   pool's pre-trade balances in the transaction, when the route is one
   constant-product pool. PumpSwap pools migrated from pump.fun carry a
   virtual quote reserve (about 17.58 SOL, stored at byte 245 of the pool
   account, read once per pool); x·y = k holds exactly with it and fails
   without. Raydium v4 / CPMM: vault ratio.
2. `ref_src: pool`: the effective price of the previous trade on the same
   pool (`getSignaturesForAddress` on the pool's token vault, `before` our
   signature; `ref_age_s` = seconds earlier). Used for the pump.fun curve
   (its stored virtual reserves no longer predict the executed price on
   2026 curves: real trades fill 20 to 60 % above virtual_sol /
   virtual_token, so the account cannot be trusted for a mid), Meteora,
   CLMM and multi-pool routes.
3. (off by default, `JUPITER_FALLBACK=1`) Jupiter's price API right after
   the sample. Audit on the live window: 29 % of Jupiter-referenced swaps
   came out with a negative loss (price read after the trade, multi-pool
   routes), against 1 % for the two on-chain references, so Jupiter-priced
   samples never enter the loss statistics. Swaps whose pool state is not
   readable keep their exact components and stay out of the loss figure;
   `ref_src_pct` says how many were priced and how.

On PumpSwap with the reserve mid the per-swap loss distribution is tight
(p10 to p90 roughly 140 to 800 bps, none negative); the previous-trade
reference carries the previous trader's impact and direction, so it is
noisier and slightly biased in buy or sell waves.

```
buy : loss = 1 − tokens × ref / user_q
sell: loss = 1 − user_q / (tokens × ref)
```

`loss_bps` is the whole shortfall the user suffered against that reference;
`terminal_bps` / `network_bps` are exact; `other_bps` (pump.fun protocol and
creator fees, referral payouts, tip services not listed) is known on
single-venue routes only; `pool_bps` = loss − terminal − network − other,
i.e. LP fee + price impact, plus the hop costs and unattributed fees on
multi-pool routes. The four components always sum to the loss. All in
basis points of the trade (buy: quote spent; sell: tokens × ref).

Network covers the tx fee and the tip accounts of Jito, 0slot, bloXroute
and Nozomi (`noz…` vanity prefix); a tip service not listed lands in
"other". Each terminal's `other_top` (largest "other" recipients over the
window, single-venue swaps) is in the JSON so new fee or tip accounts can
be spotted and classified. Rent of token accounts created or closed in the
transaction is excluded from the user's quote movement.

Failed transactions are counted from the signature scan (`fail_rate_pct`): the
user paid the priority fee for nothing, which no fill metric shows.

**Sandwiches**: the block of each sampled swap is read (`getBlock`,
`SANDWICH_SCAN_PCT` of samples, default all) and scanned for a pair of
successful transactions by the same signer on the same pool: one before
ours trading in our direction, one after trading back. `sandwich_pct` per
terminal (share of scanned swaps), attacker profit in bps of the victim's
trade, `block_pool_txs` per sample (how many other trades on that pool
the block held, so an empty result is interpretable). The victim's extra
cost is already inside `loss_bps` (the front-run precedes us, so it is in
the arrival price); the scan isolates how often it happens. Multi-block
sandwiches are not looked for.

**Trade-size buckets**: `by_size` per terminal (under $25, $25 to $250,
over $250; median loss and n from 5 samples), so terminals with different
typical trade sizes can be compared at equal size.

Why not the pool's vault ratio as the mid: PumpSwap's vault balances do not
follow x·y = k against the executed price (8–50 % off, not constant), so
the previous trade's print is the only pre-trade reference that holds on
every venue.

## Cohort

Axiom (20 wallets), GMGN (9), FOMO (fee wallet + gas sponsor excluded as
user), Photon, Trojan (6), BullX (2), Bloom, Maestro (2), Pepeboost,
BasedBot (own program scanned; its swaps do not expose a signer token leg
yet, so it stays unhealthy). BONKbot and Banana Gun have no public fee
wallet (Dune spellbook / router program only).

## Outputs

Prometheus on `:2112/metrics`, rolling `WINDOW_HOURS`:

| Gauge | Labels | Meaning |
|---|---|---|
| `tfq_loss_bps` | terminal, stat=median/mean/p90 | loss vs arrival price, priced samples; only when healthy |
| `tfq_component_bps` | terminal, component=terminal/network/other/pool | median per component |
| `tfq_fail_rate_pct` | terminal | failed / seen signatures, percent |
| `tfq_sample_size` | terminal, kind=seen/parsed/priced | |
| `tfq_trade_usd` | terminal, stat=median/mean | |
| `tfq_venue_share_pct` | terminal, venue | |
| `tfq_buy_share_pct` | terminal | |
| `tfq_sandwich_pct`, `tfq_sandwich_profit_bps` | terminal | sandwiched share of scanned swaps; median attacker profit |
| `tfq_loss_bps_size` | terminal, bucket | median loss by trade-size bucket |
| `tfq_health` | terminal | 1 when priced ≥ `MIN_PRICED` |
| `tfq_sol_usd`, `tfq_last_refresh_unix`, `tfq_rpc_calls_total`, `tfq_rpc_errors_total` | | |

JSON on `:2112/v1/fills` and mirrored to `HISTORY_FILE_PUBLIC`: per-terminal
stats plus the last 200 samples.

## Env

| Var | Default | Meaning |
|---|---|---|
| `HELIUS_API_KEY` / `SOLANA_RPC` | public RPC | RPC endpoint |
| `RPC_RPS` | `8` | pacing, calls per second |
| `TICK_SECONDS` | `90` | sweep interval |
| `SAMPLE_PER_TICK` | `4` | swaps read per terminal per tick |
| `WINDOW_HOURS` | `24` | rolling window |
| `MIN_PRICED` | `20` | priced samples before a terminal is published |
| `SANDWICH_SCAN_PCT` | `100` | share of sampled swaps whose block is read |
| `STATE_FILE` | unset | persist the window across restarts |
| `HISTORY_FILE_PUBLIC` | unset | public JSON mirror |

Budget at defaults: ~4 calls per sample (tx + previous-trade lookup) plus
wallet scans with backoff on idle wallets, about 60–80k calls a day.

```bash
docker build -t ocb-terminal-fill-quality .
docker run -d --name ocb-terminal-fill-quality --network ocb_web --restart unless-stopped \
  -v /data/state/aggregate/terminal-fills:/data/public -v /data/state/terminal-fills:/data/state \
  -e HELIUS_API_KEY=… -e STATE_FILE=/data/state/state.json -e HISTORY_FILE_PUBLIC=/data/public/fills.json \
  ocb-terminal-fill-quality
```
