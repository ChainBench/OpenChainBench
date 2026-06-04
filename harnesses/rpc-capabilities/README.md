# rpc-capabilities

OpenChainBench harness covering benches №010, №011, №012 — public RPC latency, reliability, and archive depth from a single Go binary.

## What it measures

Three concerns, one process, one set of (provider × chain) clients:

| Bench | Metric | How |
|---|---|---|
| №010 RPC latency | `eth_blockNumber` round-trip p50/p90/p99 per provider per chain | Probe every 30 s, observe latency, emit gauge + histogram |
| №011 RPC reliability | 24 h error rate per provider per chain, classified | Counter labeled by result: `ok / http_err / jsonrpc_err / stale / timeout` |
| №012 Archive RPC coverage | Whether `eth_getBalance` resolves at depths {300, 7.2k, 216k, 1.3M, 5M} from head | One probe per depth per provider, run hourly |

## Why one binary

These three benches share the same client matrix, the same headers, the same rate-limit constraints. Splitting them across three Railway services would triple the deployment footprint without reducing complexity. The collector is a single process with two goroutine families: a fast latency loop (30 s tick) and a slow archive loop (1 h tick).

## Providers tracked

| Chain | Providers |
|---|---|
| Ethereum | publicnode, drpc, 1rpc, meowrpc, flashbots, cloudflare-eth |
| Base | publicnode, drpc, mainnet.base.org |
| BNB | publicnode, drpc, bsc-dataseed1.binance.org |

Endpoint shortlist was filtered live during inception. Ankr was dropped because `rpc.ankr.com/eth` now returns JSON-RPC `-32000 Unauthorized`. llamarpc and blockpi were dropped because they return Cloudflare 5xx from multiple geos.

Every URL can be overridden via env var (`RPC_URL_<CHAIN>_<PROVIDER>`) without a rebuild.

## The reliability classification trap

A naïve "non-200 = error" reliability metric undercounts errors by 10-20% because two providers in this list (Cloudflare-eth, Ankr) return **HTTP 200 with a JSON-RPC `error` field**:

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32046,"message":"Cannot fulfill request"}}
```

The harness parses the body for every call and classifies into:

- **ok** — HTTP 200 + valid hex `result`, block is within 20 of cross-provider tip
- **http_err** — HTTP != 200 or transport failure (DNS, TLS, refused)
- **jsonrpc_err** — HTTP 200 + `error` field or empty/malformed `result`
- **stale** — HTTP 200 + valid block, but more than 20 behind the cross-provider rolling max for that chain
- **timeout** — context deadline exceeded

`rpc_call_total{result=...}` carries this taxonomy so the bench page can surface real error rate, not the optimistic version.

## Archive depth methodology

Test address is Vitalik (`0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`) because it has a non-zero balance at every block from 2015 onward — the response is unambiguous. Pruned nodes return either an explicit `missing trie node` JSON-RPC error or an empty `0x0` even though the real balance is non-zero; both count as a miss.

Probes are spaced 2 s apart per provider to keep meowrpc and Cloudflare-fronted endpoints from rate-limiting. Total time per provider per cycle: ~10 s. Full cycle (12 providers × 5 depths): ~2 min, runs once an hour.

The default Geth state cap is 128 blocks, so the **300 bucket is the canonical pruned-vs-archive separator**. The 5_000_000 bucket roughly maps to 2018 and is the genuine full-archive test. In practice every endpoint we probed is bimodal — either it serves the 300 bucket only, or it serves everything down to 5M; there is no middle ground.

## Endpoints

| Path | Purpose |
|---|---|
| `GET /metrics` | Prometheus exposition. Scraped by the OCB Prometheus. |
| `GET /health` | Plain `ok`. Railway probe. |
| `GET /` | Banner string. |

## Metrics

| Name | Type | Labels | Help |
|---|---|---|---|
| `rpc_latency_milliseconds` | gauge | provider, chain | Latest observed round-trip. |
| `rpc_latency_milliseconds_histogram` | histogram | provider, chain | Drives p50/p90/p99 via `quantile_over_time`. |
| `rpc_call_total` | counter | provider, chain, result | One increment per probe, labeled by classification. |
| `rpc_health` | gauge | provider, chain | 1 when last probe returned a fresh valid block, 0 otherwise. |
| `rpc_archive_depth_supported` | gauge | provider, chain, depth | 1 if `eth_getBalance` at (head - depth) succeeds, 0 otherwise. |

PromQL recipes:

```promql
# p50 latency for Ethereum publicnode over 24 h
quantile_over_time(0.50, rpc_latency_milliseconds{chain="ethereum",provider="publicnode"}[24h])

# 24 h error rate per provider per chain
sum by (provider, chain) (
  rate(rpc_call_total{result!="ok"}[24h])
) /
sum by (provider, chain) (
  rate(rpc_call_total[24h])
)

# Archive depth headline number per provider (max depth supported)
max by (provider, chain) (
  rpc_archive_depth_supported * on() group_left() label_replace(rpc_archive_depth_supported, "depth_num", "$1", "depth", "(.*)")
)
```

## Run locally

```bash
go run ./cmd/script
# metrics at http://localhost:2112/metrics
```

Optional env overrides:

```bash
RPC_URL_ETHEREUM_PUBLICNODE=https://your-private-node.com \
RPC_URL_BASE_DRPC=https://base.your-mirror.com \
go run ./cmd/script
```

## Deployment

Standard OCB-miniapp shape — multi-stage Dockerfile, port 2112, internal-only on Railway, scraped by `openchainbench-monitoring/prometheus/prometheus.yml` via `rpc-capabilities.railway.internal:2112`.

## Known limits

- **Single geo** — the bench currently runs from one Railway region. Latency rankings can reorder under different network paths; for full credibility the published numbers should say which geo they came from. Multi-region replication is a v2 lift (same pattern as `aggregator-head-lag`).
- **Shard variance** — `1rpc` and `flashbots` appear to load-balance across a mixed pool where some shards are pruned. The bench observes the variance honestly but reports per-cycle, so a single hourly cycle can land on either the archive or pruned shard. A v2 improvement would do a 3-probe quorum per (provider × depth).
- **Stale-state classification** — needs ≥2 working providers per chain to compute the cross-provider tip. If both Ethereum providers fail simultaneously, `stale` cannot be detected; the harness falls back to whatever tip it last observed.
- **No rate-limit signals** — none of the probed endpoints return `x-ratelimit-*` headers, so the bench cannot proactively show quotas. KyberSwap-style explicit limits would be a nice future addition.
