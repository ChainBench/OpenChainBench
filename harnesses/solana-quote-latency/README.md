# solana-quote-latency harness

Source for OpenChainBench bench [`solana-dex-quote-latency`](https://openchainbench.com/benchmarks/solana-dex-quote-latency).

Measures wallclock ms latency of Solana DEX aggregator quote APIs (Jupiter, Mobula, OpenOcean, Raydium) for the canonical 1 SOL → USDC, 50 bps slippage quote, every 60 seconds, from 3 regions (us-east, eu-west, sgp).

Exposes Prometheus metrics on `:2112/metrics` (OCB Railway convention).

## How it works

One tick = one quote per provider in parallel. Each provider adapter:

1. Builds the canonical request (1 SOL → USDC, 50 bps, dummy wallet `HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH`, no fee, no referrer).
2. Reuses a per-provider `http.Client` configured for keepalive (30s `KeepAlive`, 90s `IdleConnTimeout`, HTTP/2 attempt). After the first tick the TCP + TLS connection is reused, so the wallclock around `client.Do(req)` measures steady-state RTT (request handling + origin work + response), not the cold handshake.
3. Measures wallclock from `http.Client.Do` dispatch to the first byte of a response body containing a usable `outAmount` (`data.outAmount` for Mobula/OpenOcean, `outAmount` for Jupiter, `data.outputAmount` for Raydium).
4. Records the sample in `solana_quote_latency_ms{provider, region}`. 401/403/429/parse errors are excluded from the histogram and tracked separately.

Region is set via the `MONITOR_REGION` env var on each replica.

## Metrics

```
solana_quote_latency_ms{provider, region}                   histogram — buckets 10, 25, 50, 100, 200, 500, 1000, 2000, 5000 ms (only on success)
solana_quote_success{provider, region}                      gauge 0|1 — last cycle outcome
solana_quote_throttled_total{provider, region}              counter   — HTTP 429
solana_quote_auth_error_total{provider, region}             counter   — HTTP 401/403
solana_quote_other_error_total{provider, region, error_type} counter  — network / timeout / parse / non-2xx
```

## Run locally

```bash
cd cmd/monitor
MONITOR_REGION=local MOBULA_API_KEY=... go run .
```

Or Docker:

```bash
docker build -t solana-quote-latency .
docker run -p 2112:2112 \
  -e MONITOR_REGION=local \
  -e MOBULA_API_KEY=... \
  solana-quote-latency
curl localhost:2112/metrics | grep solana_quote_latency
```

## Environment

| Var | Default | Notes |
|---|---|---|
| `MONITOR_REGION` | `unknown` | `us-east` \| `eu-west` \| `sgp`. Self-labelled into every emitted metric. |
| `MOBULA_API_KEY` | (unset) | Required to probe Mobula. Sent as raw `Authorization: <key>` header (no Bearer prefix). |
| `JUPITER_API_KEY` | (unset) | Optional. The lite endpoint works without a key. |
| `DFLOW_API_KEY` | (unset) | Reserved. DFlow adapter is a stub pending partnership API access. |
| `LOGS_TOKEN` | (unset) | Optional, gates `GET /logs?tail=N` (404 when unset). |

OpenOcean and Raydium have no auth on their public quote endpoints.

## Endpoints

| Path | Description |
|---|---|
| `GET /metrics` | Prometheus scrape target |
| `GET /health` | Returns `200 OK` |
| `GET /logs?tail=N` | Last 5000 lines of stdout (ring buffer). Requires `X-Logs-Token: $LOGS_TOKEN` |

## Design notes

- **Warm-path measurement.** Each provider gets one `http.Client` for the life of the process and reuses TCP + TLS across ticks. This matches how a long-running backend integration actually consumes the API — the measured number is the steady-state RTT, not the first-call cold-start.
- **10s per-request timeout.** Slow responses are recorded as `other_error{error_type="timeout"}`, not as 10s latency samples.
- **60s tick.** ≈1,440 samples per provider per region per day.
- **Histogram-only buckets.** No quantile is computed inside the harness; the bench YAML uses `histogram_quantile()` on Prometheus's side over a 24-hour window. This keeps the percentiles correct across restarts and across replicas.
- **Region is hosted, not virtual.** Three Railway services in three regions each run this binary with their own `MONITOR_REGION` env. The harness does not synthesise regions itself.

## Reproducibility

Public quote endpoints. A Mobula API key is free (`https://mobula.io/api`). Anyone can clone, run, and reproduce the numbers on the bench page.
