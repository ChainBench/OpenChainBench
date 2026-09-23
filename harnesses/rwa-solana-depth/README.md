# rwa-solana-depth

Harness for bench 278, `rwa-solana-depth`: what $1k, $10k and $100k of a
tokenized real-world asset sell for on Solana, through Jupiter, relative to
a $100 sale of the same asset on the same tick, plus the on-chain supply of
each asset read from its mint (including the funds that have no market at
all, BUIDL and USTB, which the bench lists unranked).

## What it does

Every five minutes, per routed asset:

1. `$100` sale quote (`/swap/v1/quote`, token to USDC) at the previous
   tick's price, giving the reference USDC per raw unit;
2. `$1k`, `$10k`, `$100k` sale quotes, each converted to raw units at the
   reference price;
3. cost of each size = `10000 x (1 - perRaw(size) / perRaw($100))`, in
   basis points, published as `rwa_depth_cost_{1k,10k,100k}_bps{asset,issuer}`;
   a size with no route this tick has its gauge deleted.

Per unrouted asset: one unit sale quote to confirm Jupiter still has no
route (`rwa_depth_route_ok = 0`); a route appearing is logged so the asset
can move to the routed set.

Every ten minutes, per asset: `getTokenSupply` on the mint, published as
`rwa_onchain_supply_units` and, valued at the executable price per raw
unit (or BUIDL's designed $1.00), `rwa_onchain_supply_usd`.

## Metrics

| metric | labels | meaning |
|---|---|---|
| `rwa_depth_cost_1k_bps`, `..._10k_bps`, `..._100k_bps` | asset, issuer | cost of the size vs a $100 sale, bps |
| `rwa_depth_fill_usd_100k` | asset, issuer | USDC received for the $100k sale |
| `rwa_depth_route_ok` | asset, issuer | 1 when the $100k quote had a route |
| `rwa_depth_price_usd` | asset, issuer | executable USD per UI unit from the $100 quote |
| `rwa_onchain_supply_units`, `rwa_onchain_supply_usd` | asset, issuer | Solana mint supply, units and USD |
| `rwa_depth_health` | asset | 1 when the tick measured the asset |
| `rwa_depth_last_success_timestamp_seconds` | asset | freshness stamp |
| `rwa_depth_source_call_total` | source, result | fetch outcomes |

## Running

```
RWA_SOLANA_RPC=https://...   # keyed; publicnode refuses getTokenSupply without a key
LISTEN_ADDR=:2112
go run ./cmd/script
```

The Jupiter quotes are keyless (lite tier, 60 requests a minute per address, shared with the other
harnesses on the host; the harness spaces them 2.5 s apart and backs off 20 s on a 429). `XS_SOLANA_RPC` is read when
`RWA_SOLANA_RPC` is unset so the container can share the xstocks-peg env
file.

## Cohort

USDY (Ondo), PAXG (Paxos), the 12 xStocks of bench 077 (same mints and
slugs), and two unrouted funds: BUIDL (`GyWgeqpy5GueU2YbkE8xqUeVEokCMMCEeUrfbtMw6phr`)
and USTB (`CCz3SGVziFeLYk2xfEstkiqJfYkjaSWb2GCABYsVcjo2`, from Superstate's
contract list). Mints come from issuer documentation; a token-list search
returns look-alike mints for every fund.
