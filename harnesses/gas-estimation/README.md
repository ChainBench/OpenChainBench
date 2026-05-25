# gas-estimation

OpenChainBench harness — Ethereum gas oracle prediction accuracy.

## What it measures

For each gas oracle, capture the priority-fee + base-fee prediction at time T, wait until block N+1 is mined (~24 s), derive the realized priority-fee p25/p50/p90 from the actual transactions in the block, compute absolute error per oracle per tier.

| Bench axis | Metric |
|---|---|
| Priority-fee prediction accuracy | `gas_error_priority_gwei{oracle, tier}` |
| Base-fee prediction accuracy | `gas_error_base_gwei{oracle}` |
| Realized vs predicted live values | `gas_predicted_*` + `gas_realized_*` gauges |
| Oracle health / reliability | `gas_oracle_health`, `gas_oracle_call_total{result}` |

## Oracles tracked

| Slug | Endpoint | Auth | Poll cadence | Tier mapping |
|---|---|---|---|---|
| `blocknative` | `api.blocknative.com/gasprices/blockprices` | no key (free tier) | 12 s | confidence 70/80/90/95/99 → p25/p50/p75/p90/p99 |
| `publicnode-feehistory` | `ethereum-rpc.publicnode.com` `eth_feeHistory` | no key | 12 s | reward[..][0/1/2] → p25/p50/p90 |
| `owlracle` | `api.owlracle.info/v4/eth/gas` | no key | 60 s (free quota 100/h) | acceptance 0.35/0.6/0.9/1.0 → p25/p50/p90/p99 |
| `etherscan` | `api.etherscan.io/v2/api?chainid=1&module=gastracker&action=gasoracle` | no key (throttled 1/5s) | 15 s | Safe/Propose/Fast − suggestBaseFee → p25/p50/p90 |

Two more oracles (Alchemy `eth_feeHistory`, Blocknative paid Gas Platform) require a free key signup — wired via env vars but disabled by default. See `config.go` for the `GAS_TOKEN_*` and `GAS_URL_*` overrides.

The verification agent confirmed 5 candidates DEAD in 2026: Etherchain (Cloudflare 403), ethgas.watch (deprecated), ethgasstation (defunct), gasstation.network (404), api.ethgas.org / eth.gasprice.network / gastracker.io (DNS gone).

## Normalization — the methodology footnote

Every oracle calls its tiers differently (fast/standard/safelow, confidence 70-99, acceptance 0.35-1.0). The harness flattens them onto a unified percentile label set {p25, p50, p75, p90, p99} per the verification agent's mapping table.

This is opinionated and providers can dispute it. The bench page must publish the mapping explicitly. The unified tier matters because it lets the OCB site compute one ranking per percentile across all oracles instead of N tier-specific leaderboards.

## Realized-side formula

Each transaction in the block contributes one **validator-effective priority fee**:

- **EIP-1559 / EIP-4844 / EIP-7702** (type 0x2/0x3/0x4): `min(maxPriorityFeePerGas, maxFeePerGas - baseFeePerGas)` clamped at 0. Capping by `maxFeePerGas - baseFee` is critical — `maxPriorityFeePerGas` over-reports when a tx hit its `maxFeePerGas` cap.
- **Legacy / type-0x1** (type 0x0/0x1, only `gasPrice`): `max(0, gasPrice - baseFeePerGas)`.

All effective priorities are sorted into a single series; p25/p50/p90 are simple indexed percentiles. Empty blocks (0 tx) are skipped (no realized emission, counter increments) so the percentile metrics never carry forward stale values.

## Architecture

```
+-----------------+        +-----------------+
| oracle pollers  |  ---+  |   realizer      |
|  (4 goroutines) |     |  | head every 12 s |
+-----------------+     |  | catch-up ≤5 blk |
                        v  +-----------------+
                +---------------+        |
                | pending Buffer|  <-----+
                | (per-block)   |  match + emit error
                +---------------+
```

Each oracle goroutine polls on its own cadence, stuffs predictions into `pending[targetBlock]`. The realizer polls head every 12 s; when a new block is finalized it fetches the full block (with inline txs), derives the realized percentiles, joins against `pending`, computes errors, emits metrics.

Buffer has a TTL of `pendingTTLBlocks = 25` blocks (~5 min) so a realizer outage doesn't leak memory and a recovered realizer doesn't emit stale errors on ancient predictions.

Owlracle is the only oracle that doesn't return its own target block — it gets `head+1` grafted on. There's a startup-race guard: if `head` isn't known yet (realizer hasn't run), the prediction is gauge-emitted but not buffered (it would target block 1 = garbage).

## Endpoints

| Path | Purpose |
|---|---|
| `GET /metrics` | Prometheus exposition. Scraped by the OCB Prometheus. |
| `GET /health` | Plain `ok`. Railway probe. |
| `GET /` | Banner string. |

## Metrics

| Name | Type | Labels |
|---|---|---|
| `gas_predicted_priority_gwei` | gauge | oracle, tier |
| `gas_predicted_base_gwei` | gauge | oracle |
| `gas_realized_priority_gwei` | gauge | tier |
| `gas_realized_base_gwei` | gauge | (none) |
| `gas_error_priority_gwei` | gauge | oracle, tier |
| `gas_error_priority_gwei_histogram` | histogram | oracle, tier |
| `gas_error_base_gwei` | gauge | oracle |
| `gas_oracle_call_total` | counter | oracle, result |
| `gas_oracle_health` | gauge | oracle |
| `gas_realized_tx_count` | gauge | (none) |
| `gas_pending_buffer_size` | gauge | oracle |

PromQL recipes:

```promql
# 24 h p50 error per oracle per tier
quantile_over_time(0.50, gas_error_priority_gwei{tier="p50"}[24h])

# Oracle leaderboard (lower is better) — p50 tier, mean abs error 24 h
avg by (oracle) (gas_error_priority_gwei{tier="p50"})

# Reliability rate (fraction of polls that succeeded, 24 h)
sum by (oracle) (rate(gas_oracle_call_total{result="ok"}[24h]))
  /
sum by (oracle) (rate(gas_oracle_call_total[24h]))
```

## Run locally

```bash
go run ./cmd/script
# metrics at http://localhost:2112/metrics
```

Optional env overrides:

```bash
# Bump Blocknative to a paid key (5 RPS, 100k/day)
GAS_TOKEN_BLOCKNATIVE=your-key-here \
# Use Alchemy feeHistory instead of (or alongside) publicnode
GAS_URL_PUBLICNODE_FEEHISTORY=https://eth-mainnet.g.alchemy.com/v2/your-key \
go run ./cmd/script
```

## Deployment

Standard OCB-miniapp shape — multi-stage Dockerfile, port 2112, internal-only on Railway, scraped by `openchainbench-monitoring/prometheus/prometheus.yml`.

## Known limits

- **Ethereum mainnet only**. Owlracle covers bsc/poly/avax/arbitrum, feeHistory works on every chain, Blocknative free is mainnet-only, Etherscan v2 free is mainnet-only. Multi-chain bench is a v2 build that swaps the realized RPC + adapts the URL templating.
- **Blob fees not benchmarked**. Blocknative + feeHistory return `baseFeePerBlobGas` but the bench doesn't currently emit it. Add `fee_kind="blob"` axis in a v2 to surface blob predictions.
- **p75/p99 realized values are approximated** — we compute exact p25/p50/p90 from block txs but interpolate p75 = (p50+p90)/2 and p99 = p90. Oracles that emit these tiers (Blocknative, Owlracle) get a comparator, but the bench page should footnote that these are noisier than p25/p50/p90.
- **Etherscan no-key throttles at 1/5 s**. With our 15 s cadence we stay well within. If we ever go below 10 s, register a free key.
- **Owlracle 100/h no-key quota**. At 60 s cadence we use 60 polls/h = 60% of quota. A free key bumps it to 1000/h.
- **Startup window**: first few predictions during the first ~12 s aren't matched (realizer hasn't seen head yet). Owlracle skips buffering during this window; other oracles target an explicit block so are safe.
