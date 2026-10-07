# terminal-activity

Daily routed volume, swap transactions, platform fees and distinct wallets per
trading terminal, **per chain**, for benches 203, 206, 207 and 232.

Source: the public [tehcscreener API](https://tehcscreener.com/api), which is
Allium-backed. No API key, CORS open, 120 requests a minute, synced once a day.

## Why this exists

These four benches were gated to staging on 2026-10-02 when the Dune trial
ended, under a note saying they "have no free equivalent for what they
measure". This is that equivalent, and it is a different vendor rather than a
cheaper route to the same one: the bot series are Allium-derived. The one
endpoint that still carries Dune lineage is launchpad revenue (987 of its 988
days are tagged `dune_seed`), which this harness does not read.

The move also removed three structural blind spots that belonged to the old
method, not to the old vendor. Fee-wallet attribution can only see a terminal
that charges a fee, so:

- **pump.fun** takes no terminal fee and was absent from three of the four
  benches whatever its real volume.
- **BasedBot** had no public fee-wallet list and read unresponsive everywhere.
- **Fomo** sponsors the gas on the trades it routes, so the addresses on its
  transactions were its own routing accounts; its wallet count was orders of
  magnitude too low and the bench published no figure at all.

Counting routed activity directly rather than inferring it from who paid a fee
makes all three measurable, and the source is per chain rather than Solana only.

## What it does not cover

Bench 203 lost one panel in the move: the **fee-paying rate**, the share of a
terminal's transactions that actually paid a fee. The source reports fee
totals, not that share, and no arithmetic on the fields it does publish
recovers it. The panel was removed rather than approximated.

Three names left bench 206's cohort: **Padre, Phantom and Bloom** are not
covered by this source. **BullX** is in the roster with 765 days of history and
$25.6B lifetime volume, but has had no volume since 2026-05-31, so it is
published as unhealthy rather than declared on a bench where it would be a
permanently dead row.

## Run

```sh
go test ./...
go run ./cmd/script          # metrics on :2116
```

No secrets. All environment variables are optional:

| var | default | meaning |
|---|---|---|
| `TERMINAL_ACTIVITY_ADDR` | `:2116` | listen address |
| `TERMINAL_ACTIVITY_INTERVAL` | `30m` | cycle period, minimum 1m |
| `TERMINAL_ACTIVITY_MAX_AGE` | `3` | whole UTC days the data day may lag, minimum 2 |
| `TEHCSCREENER_BASE` | `https://tehcscreener.com/api/v1` | API base |

HTTP timeout is 45s per call, with a 300ms pause between per-bot calls. A cycle
makes one roster call plus one per terminal, about a dozen, so it sits far under
the published rate limit. The cadence is not worth turning down: the source
syncs once a day, so polling faster buys nothing, and 30 minutes exists so a
deploy or a late sync is picked up within the hour rather than the next day.

## Metrics on `:2116/metrics`

| metric | labels | meaning |
|---|---|---|
| `terminal_volume_usd` | platform, chain | routed volume on the latest complete day |
| `terminal_txns` | platform, chain | swap transactions |
| `terminal_fees_usd` | platform, chain | fee revenue |
| `terminal_wallets` | platform, chain | distinct wallets, per chain, never deduplicated across chains |
| `terminal_avg_trade_usd` | platform, chain | volume / transactions |
| `terminal_fee_rate_pct` | platform, chain | fees / volume * 100 |
| `terminal_trades_per_wallet` | platform, chain | transactions / wallets |
| `terminal_volume_per_wallet_usd` | platform, chain | volume / wallets |
| `terminal_chain_breadth` | platform | chains with a published row |
| `terminal_data_day_unix` | platform, chain | 00:00 UTC of the day every other gauge describes |
| `terminal_activity_health` | platform, chain | 1 published inside the window, 0 in the roster and not |
| `terminal_fee_column_ok` | chain | 0 when no terminal on the chain reported any fee |
| `terminal_activity_last_success_unix` | — | last cycle that published anything |

## Three rules worth knowing before changing this

**The headline chain is aliased, and only one chain may be.** Solana is
published under `chain="solana"` and again under `chain="all"`. The site's label
injection only rewrites a selector already pinned to `="all"`, so without the
alias a spec cannot pin the dimension, reads every chain at once, and the loader
returns null where it wanted one series. If a second chain also aliased, pinning
it would match two chains and the same null comes back from the other direction.
`chain="all"` is therefore one real slice, never a pooled total.

**Gauges are deleted, not republished.** A platform or chain that this cycle did
not publish has its figures removed and its health set to 0. These gauges are
scraped every 60 seconds and read through a 24h window, so a figure left in
place is averaged in as if it had just been measured. The source this cohort read
until 2026-09-27 froze on 2026-08-25 and was republished for 32 days with nothing
in the metrics saying so.

**The sample is the source's latest day, never the latest day that has a
number.** BasedBot routes $419M on Robinhood Chain and almost nothing on Solana.
Walking back to its last live Solana day would publish a Robinhood terminal as a
Solana participant on a bench whose question is "in the last 24 hours".

## Wallet counts are per chain for a reason

The source publishes a cross-chain deduplicated wallet count, but only for 2 of
the 9 terminals. Measured on Fomo, that deduplicated figure is about 0.6 of the
sum of its per-chain counts, because a wallet trading on two chains is one
wallet. Summing the chains would overstate every multi-chain terminal, so this
harness publishes per-chain counts everywhere and the benches read one chain at
a time rather than mixing a deduplicated column with a summed one.
