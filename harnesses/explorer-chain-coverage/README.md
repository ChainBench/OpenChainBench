# explorer-chain-coverage

OpenChainBench harness measuring **block explorer chain coverage** — for each explorer family, how many chains does it *register*, and on how many does its API demonstrably serve a *working indexer* today?

## What it measures

Three honest numbers per family, once per day:

| Number | Meaning | How |
|---|---|---|
| **registered** | Mainnets the family self-declares via a machine-readable surface | One registry/chainlist call |
| **verified** | Registered mainnets whose latest indexed block is younger than the freshness window (default 60m) | One freshness probe per chain |
| **top-50** | Of the 50 most economically active mainnets (pinned in `top50.go`), how many pass the same gate | Same probes, restricted view |

Registries rot, raw counts reward ghost rollups, marketing claims for the same vendor range from 100+ to 3000+ chains. The three numbers separate the claim, the catalog, and the working product.

## Families tracked

| Family | Key | registered source | freshness probe |
|---|---|---|---|
| Blockscout | keyless | Chainscout registry (`chains.blockscout.com/api/chains`, mainnets, `hostedBy` preserved) | `{instance}/api/v2/blocks?type=block` → `items[0].timestamp`, 8-worker sweep across distinct hosts, no retry (a dead instance IS the measurement) |
| Etherscan | free self-serve | keyless `/v2/chainlist` (testnets filtered by name) | `module=block&action=getblocknobytime&timestamp=now-window&closest=after` — queries their INDEX, unlike `module=proxy` |
| Routescan | keyless | `/v2/network/mainnet/evm/all/blockchains` | `/v2/network/mainnet/evm/{id}/blocks?limit=1` → `items[0].timestamp` |
| Blockchair | keyless | aggregate `/stats` chain keys | `/{chain}/stats` → `data.best_block_time` (UTC, no suffix) |
| OKLink | free self-serve | `/api/v5/explorer/blockchain/summary` (one call = whole family) | same call, `lastBlockTime` (epoch ms). Deprecation risk: their data-API docs were pulled during the OKX OS migration |

Keyed families are **skipped gracefully** without their env var (partial cohort).

## Fairness rules

- **Same freshness gate for everyone**: latest indexed block younger than `FRESH_WINDOW_MINUTES` (default 60 — tolerates slow producers, catches stalled pipelines). A reachable server with a stalled indexer never counts.
- **Testnets excluded everywhere.**
- **Operator attribution stays auditable**: most Blockscout instances are chain-team-run; the registry's `hostedBy` label is preserved so vendor-run vs chain-run can be split. The count measures the software family's working footprint — the claim its marketing makes — and the rule benefits every family equally.
- **Instance failures during the Blockscout sweep are never error-bucketed**: registry rot is the signal, not a fault. Only registry/chainlist fetch failures bucket errors.
- **Quota-truncated cycles publish nothing** (publish-then-leave): 401/402/403/406/429 anywhere in a keyed family's sweep invalidates that family's cycle.

## Probe budget

All surfaces free. Per cycle: Blockscout ~460 (distinct hosts, worker pool), Etherscan ~36 (600ms spacing, 3 rps free), Routescan ~37, Blockchair ~15, OKLink 1. Total ≈ 550 calls/day. `explorer_probe_calls_total{provider}` guards volume drift.

## Metrics

| Name | Type | Labels |
|---|---|---|
| `explorer_chains_registered` | gauge | provider, registered_source (`registry` \| `pinned`) |
| `explorer_chains_verified` | gauge | provider |
| `explorer_chains_top50` | gauge | provider |
| `explorer_probe_latency_ms` | gauge | provider |
| `explorer_probe_errors_total` | counter | provider, kind |
| `explorer_probe_calls_total` | counter | provider |
| `explorer_last_probe_timestamp` | gauge | provider |

## Env vars

See `.env.example`. `SKIP_INITIAL_CYCLE=1` suppresses the startup probe on deploy-storm days.

## Development

```bash
go vet ./... && go build -o /tmp/ecc ./cmd/script && go test ./...
```
