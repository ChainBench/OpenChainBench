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

The token leg is valued at an **arrival price**: the effective price of the
previous trade on the same pool (`getSignaturesForAddress` on the pool's
token vault, `before` our signature; `ref_src: pool`, `ref_age_s` = how
many seconds earlier). When no earlier trade is readable within 30 min,
Jupiter's price API is read right after the sample (`ref_src: jupiter`).

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

Not measured yet: sandwiches. The front-run lands before our transaction
in the same slot, so it is already inside the arrival price; catching it
needs the whole block (phase 2).

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
