# l1-finality

Bench № 006 — measures the live finality time of every L1 chain we can honestly observe from public endpoints. No transactions are sent. The harness either polls two RPC endpoints per chain (for slow-finality chains) or maintains a persistent WebSocket / SSE subscription (for sub-poll-cadence chains) and exposes the time delta as a Prometheus gauge.

## Why this bench is honest

Every L1 publishes a finalization-time figure in its docs. Those numbers are *targets* — what the protocol claims under ideal conditions. This bench measures what a public client can actually observe, refreshed every 10 s for slow chains and continuously for fast ones. The gap between docs and reality is the story.

## Two measurement methods

### 1. HTTP polling (slow-finality chains)

For chains where finality time is much longer than our 10 s poll interval, we read `latest.timestamp - finalized.timestamp` from the chain's RPC. Because the chain is always in a steady state where the gap between latest and finalized blocks equals the finality time, polling at any cadence gives a correct snapshot.

This works for: **Ethereum, Solana, TRON, Stellar, Hedera, SUI, Litecoin, Monero, Cardano**.

### 2. WebSocket / SSE wall-clock (sub-poll-cadence chains)

For chains where finality is faster than our poll interval, comparing two pointers at one instant doesn't measure finalization time — it measures the gap-at-instant, which collapses to zero when finalization catches up to head. The honest path is to subscribe to a push stream, record `T1 = time.Now()` when block N is first observed, and `T2 = time.Now()` when N becomes finalized. `lag = T2 − T1`, with millisecond precision, independent of chain timestamp resolution.

This works for: **BNB, Avalanche, Gram**.

## Per-chain methodology

| Chain | Method | Endpoint(s) | Finality definition | Why this depth |
| --- | --- | --- | --- | --- |
| **Ethereum** | HTTP poll | `eth_getBlockByNumber("latest" | "finalized")` | Casper FFG `finalized` tag (~64 slots) | Protocol-level. Coinbase 35, Binance 12, Circle 65 |
| **BNB** | WS wall-clock | `wss://bsc-rpc.publicnode.com` — `eth_subscribe(["newHeads"])` + 1 s `getBlockByNumber("finalized")` poll on the same socket | Wall-clock T1→T2 between block first seen as latest and as finalized | Sub-poll-cadence finality (~1.5 s) |
| **Avalanche** | WS wall-clock | `wss://avalanche-c-chain-rpc.publicnode.com/ext/bc/C/ws` — same as BNB | Same | Sub-poll-cadence (~1.5 s) |
| **Solana** | HTTP poll | `getSlot{commitment:"finalized"}` + `getBlockTime` | 32 slots (`finalized` commitment) | Circle USDC standard, industry consensus |
| **TRON** | HTTP poll | `/wallet/getnowblock` vs `/walletsolidity/getnowblock` | 19-block solidity confirmation | Protocol minimum (2/3 of 27 SRs) |
| **Stellar** | HTTP poll | Horizon `/ledgers?order=desc&limit=2` | 1 ledger back (SCP-final) | Circle = 1, deterministic SCP |
| **Hedera** | HTTP poll | Mirror `/api/v1/blocks?order=desc&limit=2` | 1 block back. Timestamps parsed at ns precision | Hashgraph aBFT deterministic |
| **SUI** | HTTP poll | `sui_getLatestCheckpointSequenceNumber` + `sui_getCheckpoint` | 1 checkpoint back | Circle USDC = 1, Mysticeti finalizes in 1 |
| **Gram** | SSE wall-clock | `tonapi.io/v2/sse/blocks?workchain=-1` (masterchain only) | Time between consecutive masterchain blocks | Gram (formerly TON) docs: a tx is final once included in a masterchain block, so block_N is final when block_N+1 commits |
| **Litecoin** | HTTP poll (probabilistic) | blockchair `/stats.best_block_height` and `/dashboards/block/{height}.block.time` | 12 confirmations | Coinbase deposit standard, post-April-2026 13-block MWEB reorg |
| **Monero** | HTTP poll (probabilistic) | monero-rpc `get_info` + `get_block_header_by_height` (with cakewallet/sethforprivacy/monerujo failover) | 10 confirmations | Wallet protocol unlock period |
| **Cardano** | HTTP poll (probabilistic) | koios `/tip` + `/blocks?block_height=eq.<height>` | 15 confirmations | Above Coinbase 10 / Kraken 15. Far below the academic k=2160 (~12 h) |

## Excluded chains

| Chain | Why |
| --- | --- |
| **XRP Ledger** | `ledger_current` has no `close_time`, so any HTTP-based lag formula collapses to either a hardcoded `block_lag × 4 s` (not a real measurement) or zero. Honest measurement requires WS subscribe to the validated-ledger stream — not yet implemented |

## Metrics emitted

```
# HTTP-polled chains
l1_finality_lag_seconds{chain}                  # latest.ts - finalized.ts (chain-side resolution)
l1_finality_block_lag{chain}                    # height delta in blocks
l1_latest_block{chain}
l1_finalized_block{chain}
l1_finality_fetch_latency_milliseconds{chain}   # how long the RPC pair took
l1_finality_last_refresh_timestamp_seconds{chain}
l1_finality_fetch_errors_total{chain, error_type}
l1_finality_health{chain}                       # 1 if last sample succeeded

# Wall-clock-measured chains (BNB, Avalanche, Gram)
l1_finality_wallclock_lag_milliseconds{chain}        # ms-precise gauge
l1_finality_wallclock_lag_milliseconds_histogram     # histogram for tail latency
l1_finality_wallclock_health{chain}                  # 1 if WS/SSE connected
l1_finality_wallclock_samples_total{chain}           # cumulative count
```

## Confidence audit

| Chain | Confidence | Notes |
| --- | --- | --- |
| Ethereum | High | RPC returns true protocol-level `finalized` |
| BNB | High | WS wall-clock methodology is rigorous |
| Avalanche | High | Same WS wall-clock |
| Solana | High | Industry-standard `finalized` commitment |
| Hedera | High | Hashgraph aBFT + ns-precision timestamps |
| SUI | High | 1 checkpoint = Circle USDC standard |
| Stellar | High | SCP deterministic, Circle = 1 |
| Gram | High (after SSE refactor) | tonapi `workchain=-1` SSE stream, ms-precise |
| Cardano | Medium | 15-conf compromise between Coinbase 10 and Kraken 15. Academic k=2160 is theoretical; no actor uses it |
| Litecoin | Medium | 12-conf post-April-2026 reorg; standard is evolving |
| TRON | Medium | CEX confirmation counts vary 19–30; we use the 19-block protocol minimum |
| Monero | Lower | XMR delisted from major regulated CEXes since 2024; no canonical confirmation count today |

## Run locally

```bash
cd miniapps/l1-finality
go run ./cmd/script/
```

`/metrics` is exposed on `:2112`. Other endpoints:

| Endpoint | What |
| --- | --- |
| `GET /metrics` | Prometheus scrape |
| `GET /logs?tail=N` | In-memory log ring (5000 lines). `LOGS_TOKEN` env gates access if set |
| `GET /debug/finality` | JSON snapshot per polled chain — block heights, lag, latency, last error |
| `GET /health` | `OK` |

## Run on Railway

Deploy from this directory. No required env vars — public defaults work. Optional overrides:

| Var | What | When |
| --- | --- | --- |
| `RPC_<CHAIN>` | Override the public RPC URL | Recommended in production to avoid public-RPC rate limits |
| `REFRESH_INTERVAL_SECONDS` | HTTP-poll cadence | Default 10, min 5. Doesn't affect WS-measured chains |
| `LOGS_TOKEN` | Bearer token gating `/logs` | Optional |

The WS/SSE subscribers connect with hard-coded public endpoints (publicnode for BNB/Avalanche, tonapi.io for Gram) — no auth required.

## Adding a chain

### HTTP-polled chain

1. Append a `ChainConfig` entry in `cmd/script/config.go`.
2. If it's another EVM chain, that's it — the existing `fetchEVM` handles it.
3. If it's a new family, add a `<chain>.go` with a `fetch<Chain>(ch ChainConfig) FinalitySample` function and wire it in `fetchOne()` in `main.go`.

### Wall-clock-measured chain

1. Add a goroutine that maintains the WS/SSE subscription. See `evm_ws.go` (BNB/Avalanche) or `ton_ws.go` (Gram) for the pattern. The file is still named `ton_ws.go` after the chain's pre-rebrand identifier; rename safely once the harness is redeployed.
2. Record `firstSeen[height] = time.Now()` on each new-block event.
3. On finality observation (either an explicit finalized-tag advance or "next block referenced this one"), emit the lag via `wallClockLagGauge.WithLabelValues(slug).Set(lagMs)`.
4. Don't add the chain to the polled `Chains` config list — wall-clock chains run as separate goroutines.
5. Wire the start function from `main.go` (e.g. `StartTONWallClock()`).

## License

MIT — same as the rest of OpenChainBench.
