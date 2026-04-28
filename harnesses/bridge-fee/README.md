# Harness · bridge-fee

> Extracts the effective cost (fees + slippage + destination gas) from each bridge quote and records it.

**Bench**: [№ 003 · Bridge Fee](../../benchmarks/bridge-fee.yml)

## What it measures

- **Effective fee** — what a user actually pays, as a percentage of trade size. Includes protocol fees, relayer fees, slippage and destination gas.
- **Sample count** — number of quotes captured per bridge per route per amount.

This harness shares the same runner as `bridge-quote` — it emits cost
metrics from the same quote responses. The split into two benchmarks is
purely editorial: one report on speed, one on cost.

## Bridges

`mobula` · `relay` · `lifi` · `debridge`

## Inputs

- Routes: USDC pairs spanning Solana, Base and Arbitrum.
- Reference notional: $300 USDC. The harness also captures $5 and $50 but the bench filters to $300 to avoid fixed-fee blowups skewing the percentile aggregates.
- Cadence: full sweep every 5 minutes.
- Region: currently `eu-west` only.

## Metrics emitted

```
bridge_fees_percent{bridge, ...}        gauge — explicit fee field, in percent
bridge_cost_percent{bridge, ...}        gauge — fees + slippage + gas, in percent (used by bench)
bridge_fees_usd{bridge, ...}            gauge
bridge_cost_usd{bridge, ...}            gauge
bridge_slippage_usd{bridge, ...}        gauge
bridge_gas_usd{bridge, ...}             gauge
bridge_fix_fee_usd{bridge, ...}         gauge — Debridge native-token fees
bridge_output_usd{bridge, ...}          gauge
```

## Why `bridge_cost_percent` and not `bridge_fees_percent`

Some providers (Mobula in particular) bake their take into the spread
rather than reporting an explicit fee field. Comparing only
`bridge_fees_percent` would render those providers at 0% — misleading
readers about what they actually pay. `bridge_cost_percent` measures the
bottom-line cost regardless of how each provider structures pricing.

## Running locally

> Implementation TBD — same runner as `bridge-quote/`.
