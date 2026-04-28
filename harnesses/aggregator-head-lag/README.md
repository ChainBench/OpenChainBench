# Harness · aggregator-head-lag

> Watches reference pools across multiple chains and records the gap between an on-chain event and its appearance on each aggregator's data feed.

**Bench**: [№ 001 · Aggregator Head Lag](../../benchmarks/aggregator-head-lag.yml)

## What it measures

- **Head lag** — wall-clock time between an on-chain Swap event and the same event appearing on the aggregator's WebSocket / GraphQL / REST feed.
- **Presence** — share of expected sampling slots where a value was actually emitted (proxy for feed reachability).

## Aggregators

`mobula` · `codex` · `geckoterminal`

## Inputs

- Reference: archive nodes per chain, peered to multiple sources, validated against block hash.
- Chains: Base, BNB Chain, Solana.
- Cadence: sampled every 15 seconds per aggregator × chain × region.
- Regions: `us-east`, `eu-west`, `sgp`.

## Metrics emitted

```
head_lag_seconds{aggregator, chain, region}              gauge
head_lag_milliseconds{aggregator, chain, region}         gauge (× 1000 of seconds)
head_lag_errors_total{aggregator, chain, region, error_type}  counter
mobula_head_lag_detailed_seconds{aggregator, chain, region, pool_address}  gauge
mobula_processing_lag_seconds{...}                        gauge (server-side breakdown)
mobula_network_lag_seconds{...}                           gauge (network breakdown)
aggregator_head_block{aggregator, chain, region}          gauge
blockchain_head_block{chain, region}                      gauge (canonical tip)
```

## Env vars

| Var                   | Required | Notes                                |
| --------------------- | -------- | ------------------------------------ |
| `MOBULA_WS_URL`       | yes      | Mobula WebSocket endpoint            |
| `CODEX_API_KEY`       | yes      | https://docs.codex.io                |
| `GECKOTERMINAL_KEY`   | optional | Public endpoints work without it     |
| `ETH_RPC_URL`         | yes      | Archive node for canonical reference |
| `SOL_RPC_URL`         | yes      |                                      |
| `BSC_RPC_URL`         | yes      |                                      |
| `PROMETHEUS_PUSH_URL` | yes      | Prometheus push gateway              |
| `MONITOR_REGION`      | yes      | one of `us-east`, `eu-west`, `sgp`   |

## Running locally

> Implementation TBD. This README describes the contract; the runner code
> lives in the team's separate harness repo and pushes metrics to the
> Prometheus instance referenced in the spec YAML.

```bash
make run REGION=eu-west
```
