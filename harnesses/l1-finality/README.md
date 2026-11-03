# l1-finality

Bench № 006 measures how long a block takes to become final on every chain we can observe honestly from public endpoints, each against the chain's own finality rule. No transactions are sent. The published figure is never a published block time added to a published TTF: either both ends are observed (T1 when block N is first seen, T2 when it is final) or, where a chain has no unfinalized head, the block's own timestamp is the start and its arrival, already final, the end.

## Four measurement methods

### 1. Head and final block, two pointers (T2 − T1)

Where a head and a final block coexist, `lag = T2 − T1`.

- **WebSocket, our clock** (BNB, Robinhood Chain, Solana): T1 = first time block N arrives on the head stream, T2 = first time the finalized pointer reaches it. Millisecond precision, independent of block timestamp resolution.
- **Block timestamps, polled every 10 s** (Ethereum, TRON, Monero): `latest.timestamp − finalized.timestamp`. Only valid where finality is far longer than the poll and the timestamp resolution.
- **Block timestamps, nanoseconds** (NEAR): every header names `last_final_block`; sample = timestamp of the first block naming F − timestamp of F.
- **Tip height, our clock** (Bitcoin 6 confirmations, Litecoin 12): T1 = first poll where N is the tip, T2 = first poll where the tip is N + depth. Miner-set timestamps are never used.

### 2. Already final when it appears: block timestamp to arrival

On Avalanche (since Streaming Asynchronous Execution), Sei, Cronos, Kaia and the Internet Computer, every block a client can see is already final, so latest → finalized is zero by construction. The figure is the block's own timestamp (the producer's clock) to the moment it reaches us. Readings outside 0 to 60 s are dropped as clock skew or replay.

### 3. Interval between two final blocks

Stellar (ledger close), Gram (masterchain block), SUI (checkpoint) and Algorand (round) finalize at every unit, so the interval between two units is how often finality lands, and for Algorand one round is one proposal → certification cycle.

## Per-chain methodology

| Chain | Method | Endpoint (default) | Finality signal | Sample |
| --- | --- | --- | --- | --- |
| **Ethereum** | 10 s poll | `RPC_ETHEREUM`, publicnode | Casper FFG `finalized` tag | `latest.ts − finalized.ts` |
| **BNB** | WS, our clock | `wss://bsc-rpc.publicnode.com` | `finalized` tag (BEP-126 fast finality), polled every 1 s on the socket | first seen latest → first seen finalized |
| **Robinhood Chain** | WS, our clock | `wss://robinhood-rpc.publicnode.com` | `finalized` tag, moves by batch on the parent chain | batch median of first seen latest → finalized |
| **Avalanche** | WS, from production | `wss://avalanche-c-chain-rpc.publicnode.com/ext/bc/C/ws` | `latest` is accepted (Snowman-final) under SAE | arrival − `timestampMilliseconds` |
| **Solana** | WS, our clock | `WS_SOLANA`, `wss://api.mainnet-beta.solana.com` | `rootSubscribe` (Alpenglow) | first `slotSubscribe` of S → first root ≥ S |
| **TRON** | 10 s poll | `RPC_TRON`, trongrid | `/walletsolidity/getnowblock` (19 SR confirmations) | head.ts − solid.ts |
| **Monero** | 10 s poll | `RPC_MONERO`, cakewallet | 10 confirmations | tip.ts − (tip − 10).ts |
| **NEAR** | 2 s poll, chain ns timestamps | `RPC_NEAR`, `https://near.drpc.org` | `last_final_block` (BFT finality) | ts(first block naming F) − ts(F) |
| **Sei** | WS, from header time | `WS_SEI`, `wss://sei-rpc.publicnode.com/websocket` | commit (single-slot BFT) | arrival − header `time` (proposal) |
| **Cronos** | WS, from header time | `WS_CRONOS`, `wss://cronos-rpc.publicnode.com/websocket` | commit (CometBFT) | arrival − header `time` (BFT time = previous commit, so one whole height) |
| **Kaia** | WS, from block start | `WS_KAIA`, `wss://public-en.node.kaia.io/ws` | commit (Istanbul BFT) | arrival − timestamp, on-time blocks only (timestamp = parent + 1 s) |
| **Internet Computer** | 250 ms poll | `RPC_ICP`, `https://icp-api.io`, NNS subnet | certified state | arrival (midpoint of two answers) − certified `/time` |
| **Algorand** | long poll, our clock | `RPC_ALGORAND`, `https://mainnet-api.algonode.cloud` | certified round | arrival(r+1) − arrival(r), consecutive rounds |
| **Stellar** | SSE, chain close times | Horizon `/ledgers?cursor=now` | SCP close | (closed_at(N) − closed_at(N−10)) / 10 |
| **Gram** | SSE (REST fallback), our clock | tonapi.io `/v2/sse/blocks?workchain=-1` | masterchain inclusion | first sight of N+1 − first sight of N |
| **SUI** | 500 ms poll, checkpoint timestamps | `graphql.mainnet.sui.io` | checkpoint commit (Mysticeti) | (ts(N) − ts(M)) / (N − M) |
| **Bitcoin** | 30 s poll, our clock | mempool.space | 6 confirmations | tip first seen → tip − N ≥ 6 |
| **Litecoin** | 30 s poll, our clock | Tatum public JSON-RPC | 12 confirmations | same as Bitcoin |
| **Cardano** | 60 s poll | koios | 15 confirmations | measured, not published on the board |

### Notes per new chain (added 2026-11-03)

- **Sei**: the header time read 0.2 to 0.3 s before arrival, inside one ~0.45 s block interval, so it marks this block's proposal.
- **Cronos**: CometBFT BFT time is the median of the validators' precommit times for the previous height; arrival − header time is therefore the previous commit → this commit + delivery (about one ~0.4 s height plus delivery).
- **Kaia**: kaia `work/worker.go` (`waitForIdealBlockTime`) sleeps until `parent.Time + 1 s`, a whole second, then builds the block with that timestamp (`blockchain.go` `PrepareHeader`). A late block gets `Time = now` truncated and the fraction in `timestampFoS`, which `newHeads` does not carry, so only blocks with timestamp = parent + 1 are timed. `timestampFoS` on on-time blocks is inherited from the parent and is not a clock.
- **Internet Computer**: anonymous `read_state` for the path `["time"]` on canister `ryjl3-tyaaa-aaaaa-aaaba-cai` (ICP ledger, NNS subnet). The request and the certificate tree are CBOR, encoded and decoded in `icp.go` without a dependency. The certificate's BLS signature is not verified: only the timestamp is used.
- **NEAR**: both ends are chain timestamps, so the 2 s poll sets the sample count, not the value. Each poll fetches the head, then its parent and its final block by hash unless cached (at most 1.5 requests/s). Both FastNEAR hosts (`rpc.mainnet`, `free.rpc`) answered 429 at 1.5 to 5 requests/s; dRPC's free endpoint served 90 of 90 at 1.5 requests/s.
- **Algorand**: block `ts` is whole seconds, too coarse for a ~3 s figure. The next round's proposal starts once a round is certified, so the commit-to-commit interval is one proposal → certification cycle.

## Excluded chains

| Chain | Why |
| --- | --- |
| **Hedera** | Mirror nodes only publish already-final records, stamped with the consensus time (the moment of finality itself), so nothing before finality is observable. Re-enable once Block Nodes (HIP-1056) leave private preview |
| **XRP Ledger** | `ledger_current` has no `close_time`; honest measurement needs a WS subscription to the validated-ledger stream, not implemented |
| **Aptos** | A fullnode serves only committed blocks. On 2026-11-03 the latest block's microsecond `ledger_timestamp` read 0 to 200 ms before arrival, often after our request had left, so it does not mark the proposal and timestamp → arrival would publish mostly our round trip. The Aptos Labs API also answered 429 at 4 requests/s |
| **Somnia** | `latest`, `safe` and `finalized` return the same block, and block timestamps are whole seconds on blocks about 100 ms apart: neither a head → final gap nor timestamp → arrival can resolve its sub-second finality |

## Changes on 2026-11-03

- **BNB** (`evm_ws.go`, `wsStalled`): from 2026-11-02 the row produced no sample for hours at a time (14:45 to 20:25, 03:15 to 08:43, 11:53 to 14:34 UTC) while health stayed 1 and the gauge held its last value, which `quantile_over_time` counted at every scrape. A socket with no head for 20 s, or no `finalized` advance for 30 s on a finalized-tag chain, is now reconnected.
- **Stellar** (`stellar_ws.go`): the sample was the gap between two ledgers arriving on the Horizon stream. Horizon delivers unevenly (3.1, 4.0, 7.1 s gaps between ledgers whose `closed_at` were all exactly 5 s apart), so the published p50 of 4.0 s and p90 of 11 s were delivery artifacts. The sample is now the mean close interval over the last ten ledgers from `closed_at`.

## Metrics emitted

```
# 10 s polled chains (Ethereum, TRON, Monero, Cardano)
l1_finality_lag_seconds{chain}                  # latest.ts - finalized.ts
l1_finality_block_lag{chain}                    # height delta in blocks
l1_latest_block{chain}
l1_finalized_block{chain}
l1_finality_fetch_latency_milliseconds{chain}
l1_finality_last_refresh_timestamp_seconds{chain}
l1_finality_fetch_errors_total{chain, error_type}
l1_finality_health{chain}

# every other chain
l1_finality_wallclock_lag_milliseconds{chain}        # last sample, ms
l1_finality_wallclock_lag_milliseconds_histogram     # every sample
l1_finality_wallclock_health{chain}                  # 1 while the stream / poll is up
l1_finality_wallclock_samples_total{chain}
l1_finality_solana_stage_milliseconds{stage}         # Solana block / vote split
```

Chain labels: `ethereum bnb robinhood avalanche solana tron monero cardano near sei cronos kaia icp algorand stellar gram sui bitcoin litecoin`.

## Run locally

```bash
cd harnesses/l1-finality
go test ./... && go run ./cmd/script/
```

`/metrics` is on `:2112` (`METRICS_ADDR` overrides it). Other endpoints:

| Endpoint | What |
| --- | --- |
| `GET /metrics` | Prometheus scrape |
| `GET /logs?tail=N` | In-memory log ring (5000 lines). `LOGS_TOKEN` gates access if set |
| `GET /debug/finality` | JSON snapshot per 10 s polled chain |
| `GET /health` | `OK` |

## Environment

No variable is required; every default is a public, keyless endpoint.

| Var | What |
| --- | --- |
| `RPC_ETHEREUM`, `RPC_TRON`, `RPC_MONERO`, `RPC_CARDANO` | 10 s polled chains |
| `RPC_NEAR`, `RPC_ICP`, `RPC_ALGORAND` | polled chains added 2026-11-03 |
| `WS_SOLANA`, `WS_SEI`, `WS_CRONOS`, `WS_KAIA` | WebSocket overrides |
| `TON_API_KEY` | tonapi.io SSE (anonymous requests get 401; the REST fallback runs without it) |
| `REFRESH_INTERVAL_SECONDS` | 10 s poll cadence, min 5 |
| `METRICS_ADDR` | listen address, default `:2112` |
| `LOGS_TOKEN` | bearer token for `/logs` |

## Adding a chain

1. Find the chain's own finality signal and check it live. If every block is final when it appears, find a sub-second timestamp that marks the block's start (and prove it from the client source); if there is none, the chain is excluded, not approximated.
2. A 10 s polled chain is a `ChainConfig` in `config.go` plus a fetcher in `fetchOne()`. Anything faster is a goroutine started from `main.go` that writes `recordWallClock(slug, ms)` and sets `wallClockHealth`.
3. Put the parsing in a pure function with a test (`new_chains_test.go`).

## License

MIT, same as the rest of OpenChainBench.
