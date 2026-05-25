# l2-block-time

OpenChainBench bench № 009 — live wall-clock block time for every major Layer-2.

One persistent WebSocket per chain subscribes to `eth_subscribe("newHeads")` and records the wall-clock interval between consecutive head events. p50 / p90 / p99 are computed via Prometheus `quantile_over_time` in the OCB spec YAML.

## Why this metric

Every L2 marketing page quotes a single nominal block time ("Base: 2 s", "Arbitrum: 250 ms"). Reality has a fat tail — sequencer batching, idle gaps, prover lag on zk rollups — that the nominal figure hides. This harness captures the live distribution so the leaderboard ranks chains on actual measured cadence rather than declared spec.

## Chains tracked

| Slug | Chain | Default WS endpoint | Nominal block time |
|---|---|---|---|
| arbitrum | Arbitrum One | wss://arbitrum-one-rpc.publicnode.com | ~250 ms |
| optimism | Optimism | wss://optimism-rpc.publicnode.com | 2 s |
| base | Base | wss://base-rpc.publicnode.com | 2 s |
| zksync | zkSync Era | wss://mainnet.era.zksync.io/ws | ~3 s, batched |
| linea | Linea | wss://linea-rpc.publicnode.com | ~3 s, batched |
| scroll | Scroll | wss://scroll-rpc.publicnode.com | ~3 s, batched |
| blast | Blast | wss://blast-rpc.publicnode.com | 2 s |
| mantle | Mantle | wss://mantle-rpc.publicnode.com | 2 s |
| taiko | Taiko | wss://taiko-rpc.publicnode.com | 3 s |

Every URL was probed live before inception (90 s newHeads window): all 9 confirmed subscribe, no API key required, no idle disconnect at 60 s.

## Endpoints

| Path | Purpose |
|---|---|
| `GET /metrics` | Prometheus exposition. Scraped by the centralized OCB Prometheus. |
| `GET /health` | Plain `ok`. Railway healthcheck. |
| `GET /` | Banner string. |

## Metrics

| Name | Type | Labels | Help |
|---|---|---|---|
| `l2_block_time_milliseconds` | gauge | chain | Latest observed wall-clock interval between two `newHeads` events. |
| `l2_block_time_milliseconds_histogram` | histogram | chain | Distribution of samples — drives p50 / p90 / p99 on the bench page. |
| `l2_block_time_health` | gauge | chain | 1 when the WS is connected, 0 otherwise. |
| `l2_block_time_samples_total` | counter | chain | Cumulative samples since process start. |
| `l2_block_time_reconnects_total` | counter | chain | Cumulative WS reconnections — sustained non-zero rate flags upstream instability. |

PromQL recipe for p50 over the last 24 h:

```promql
quantile_over_time(0.50, l2_block_time_milliseconds{chain="arbitrum"}[24h])
```

## Run locally

```bash
cp .env.example .env
go run ./cmd/script
```

Metrics at `http://localhost:2112/metrics`.

## Deployment

Standard OCB-miniapp shape — multi-stage Dockerfile, port 2112, scraped by `openchainbench-monitoring/prometheus/prometheus.yml` over Railway's internal DNS.

## Known limits

- **Public endpoint variance** — publicnode.com endpoints occasionally rate-limit or close idle connections. Reconnect logic with exponential backoff (2 s → 60 s) covers this; sustained reconnect rate >1/min per chain is the alert threshold.
- **Sample-size on batched rollups** — Linea, Scroll, zkSync produce blocks in bursts. p50 reflects within-burst cadence; p99 reflects idle-gap recovery. Both are honest signals, not artifacts.
- **No Polygon zkEVM / Mode** — neither exposes a public no-key WS. Will add via HTTP poll when v2 lands, or with an API key sourced from the contributor's environment.
- **Starknet excluded** — Cairo stack, separate RPC shape, lives in a future `l2-starknet-block-time` if demand justifies it.
