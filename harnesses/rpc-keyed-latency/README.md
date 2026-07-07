# rpc-keyed-latency

Latency + reliability of **signup-gated free-tier** RPC endpoints (Alchemy,
Infura, Chainstack, Ankr, Helius), probed continuously from 3 regions.
Companion to `rpc-capabilities` which covers **no-key** public endpoints —
same anti-cache probe, same classification rules, so the two tiers stay
methodologically comparable.

| Bench | Measures | How |
|---|---|---|
| Keyed RPC latency | `eth_getBlockByNumber(latest)` (EVM) / `getSlot` (Solana) round-trip p50/p90/p99 per provider per chain | Probe every 60 s per region, rotating request id (anti-cache), gauge + histogram with `tier="keyed"` |

## Env contract

Endpoints are **never** committed — every URL embeds an API key. A
(provider, chain) cell is probed iff its env var is set:

```
RPC_KEYED_URL_<PROVIDER>_<CHAIN>   e.g. RPC_KEYED_URL_INFURA_ETHEREUM
```

Providers: `INFURA` `ALCHEMY` `CHAINSTACK` `ANKR` `HELIUS`.
Chains: `ETHEREUM` `BASE` `ARBITRUM` `OPTIMISM` `BNB` `POLYGON` `SOLANA`.

Tuning:

- `REGION` — us-east | eu-west | sgp (else derived from `RAILWAY_REPLICA_REGION`)
- `RPC_KEYED_PROBE_SECONDS` — default 60
- `RPC_KEYED_BUDGET_<PROVIDER>` — per-REGION monthly request budget override

## Quota guard

Each region gets 1/3 of a provider's monthly free quota (defaults in
`config.go`, derived from the 2026-07 free-tier audit). Probing for a
provider pauses at **90% of the region budget** until calendar-month
rollover and emits `rpc_keyed_quota_used_ratio` + `result="quota_paused"`
counters. Never exhaust a free key: a dead key blanks the bench until
manual rotation (see the CoinStats credits incident).

The counter is in-memory: a restart under-counts, which is safe because
budgets already target ≤2/3 of the provider's real quota.

## Metric namespace

Same metric names as `rpc-capabilities` (`rpc_latency_milliseconds`,
`rpc_call_total`, `rpc_health`) so shared recording rules apply, with a
`tier="keyed"` label. Provider slugs are disjoint from the no-key
cohort; if a provider ever appears in both tiers its keyed slug must be
distinct (e.g. `drpc-free-tier`).
