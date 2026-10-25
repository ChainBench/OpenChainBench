# privacy-rails

What it costs to move into a privacy asset and back out, how long it takes,
and which rails can actually pay a shielded address.

Quote-only. No API key, no wallet, no signing. Every endpoint it touches
answered keyless when it was measured on 2026-10-25, and if one starts asking
for a credential the result is a visible probe failure rather than a silent
key lookup.

## What it measures

| metric | question |
|---|---|
| `privacy_round_trip_bps` | basis points lost going in and back out, by rail, asset and size |
| `privacy_round_trip_seconds` | the two legs' quoted duration, in plus out |
| `privacy_exit_cost_bps` | size impact on the way out, against the smallest size that quotes |
| `privacy_shielded_payout_accepted` | 1 if the rail accepts a shielded destination, 0 if it refuses |
| `privacy_transparent_payout_accepted` | the control for the line above |
| `privacy_shielded_refusal_total` | refusals by the reason the rail gave |
| `privacy_quote_out_asset` | output quoted per destination kind, transparent and shielded, unsubtracted |
| `privacy_pool_depth_asset` | the liquidity the cost came out of |
| `privacy_xmr_*` | the BTC to XMR maker book: count, dispersion, best price, size range |

## The cohort, and why it is this small

Measured on 2026-10-25, with the asset lists read off each venue rather than
taken from its marketing:

- **Maya** carries `ZEC.ZEC` and `DASH.DASH`, both Available. Its ZEC pool was
  47.8 % of all Maya volume that day, tied with BTC at 48.1 %.
- **NEAR Intents** carries ZEC natively plus wrapped on four chains. No XMR
  anywhere in its 205 tokens.
- **Chainflip** carries no privacy asset at all. Confirmed with two controls
  that pass: Solana/SOL and Bitcoin/BTC both quote 200 while ZEC, XMR and
  DASH refuse.
- **THORChain** was unreachable on twelve hosts (DNS failures, Cloudflare
  challenges, and a `thornode.thorchain.liquify.com` certificate that expired
  on 7 February 2024). Not probed until a live endpoint exists.
- **UnstoppableSwap** is the only live non-custodial Monero rail found.

## The one guard this harness is built around

The shielded-payout question was attempted three times before this code and
voided three times, always the same way: an address string that was
remembered or reconstructed rather than read, whose checksum failed, so the
rail refused BOTH the shielded and the transparent probe. Two identical
refusals say nothing about the rail; they say the prober is broken.

So:

1. Both destinations are checksum-verified at startup (`addresses.go`), and a
   failure disables the delivery probe instead of publishing a verdict.
2. The transparent address is probed FIRST and is the control. A shielded
   refusal is only recorded when the control was accepted.
3. `addresses_test.go` pins the exact strings that fooled the earlier
   attempts, including one built by hand from a truncated error message.

## Running it

```
MONITOR_REGION=us-east TICK_SECONDS=300 ./monitor
```

`METRICS_ADDR` defaults to `:2112`. Gates: `gofmt -l .`, `go build ./...`,
`go vet ./...`, `go test ./...`.

## Two readings that are real and look like bugs

**The round trip is not monotonic in size.** ZEC through Maya came back at
77.5 bps for 0.001 BTC, 40.7 for 0.01 and 325 for 0.1: the fixed outbound fee
dominates the small end and depth dominates the large end, so the cheapest
size is in the middle.

**The maker book churns.** UnstoppableSwap showed 9 makers and then 7 within
an hour. A dispersion or a count read once is a snapshot, not a level.
