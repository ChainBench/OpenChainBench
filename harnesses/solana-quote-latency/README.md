# solana-quote-latency harness

Source for OpenChainBench bench [`solana-dex-quote-latency`](https://openchainbench.com/benchmarks/solana-dex-quote-latency).

Every 60 s the harness picks a **long-tail Solana token** from the live trending list and asks each of Jupiter, Mobula, OpenOcean and Raydium for a `100 USDC → tokenOut` quote. Rotating the `tokenOut` defeats the per-pair edge cache Jupiter maintains on the most-popular pairs (SOL, USDT, CBBTC), so the recorded number reflects the routing-search cost rather than a CDN hit.

Exposes Prometheus metrics on `:2112/metrics` (OCB Railway convention).

## How it works

A persistent goroutine refreshes the rotation list every 10 minutes from Mobula's market-query API (`api.mobula.io/api/1/market/query?sortBy=volume&sortOrder=desc&blockchain=Solana&limit=50&offset=5`). That returns Solana tokens ranked 6-55 by 24 h volume — past the always-cached top five (USDC, USDT, CBBTC, SOL, USD1) but inside the band where every aggregator can still find a route. Stablecoins by symbol and tokens with < $50 k liquidity are dropped client-side.

One tick = one randomly picked token from that list × four parallel probes. Each provider adapter:

1. Builds the canonical request: `inputMint=USDC, outputMint=<picked>, amount=100 USDC, slippage=1%`.
2. Reuses a per-provider `http.Client` configured for keep-alive (30 s `KeepAlive`, 90 s `IdleConnTimeout`, HTTP/2 attempt). After the first tick the TCP + TLS connection is reused, so the wallclock around `client.Do(req)` measures steady-state RTT (request handling + origin work + response), not the cold handshake.
3. Measures wallclock from `client.Do` dispatch to the first byte of a response body containing a usable out-amount (`outAmount` for Jupiter, `data.amountOutTokens` for Mobula, `data.outAmount` for OpenOcean, `data.outputAmount` for Raydium).
4. Records the sample on `solana_quote_latency_ms{provider, region}` **only when** the response is a real quote. Throttle / auth / no-route / network errors land on their own counters and are excluded from the histogram.

Region is set via `MONITOR_REGION` on each Railway replica.

## Failure classification

Each tick records exactly one counter for a non-success outcome:

| Counter | Trigger |
|---|---|
| `solana_quote_throttled_total` | HTTP 429 |
| `solana_quote_auth_error_total` | HTTP 401/403 |
| `solana_quote_no_route_total` | Provider returned a recognisable "this token has no path on me" signal (see below) |
| `solana_quote_other_error_total{error_type}` | Anything else (network/timeout/parse/validation/non-2xx) |

`no_route` is its own bucket because every provider is allowed to honestly say "I can't route this token". Counting that as a latency outlier would punish providers that fail fast and reward providers that hallucinate a number. Verified no-route signals:

- **Jupiter**: HTTP 400 with `errorCode: NO_ROUTES_FOUND` or `errorCode: TOKEN_NOT_TRADABLE`.
- **Mobula**: HTTP 4xx with `error: "No route found"` or `error: "Token not found: solana:solana:<mint>"`.
- **Raydium**: HTTP 200 + `success: false` + `msg: INSUFFICIENT_LIQUIDITY` or `msg: ROUTE_NOT_FOUND`. Raydium's compute API is single-venue (Raydium AMM v4/CPMM/CLMM only) and does not multi-hop, so it returns no-route on roughly 30-50% of long-tail tokens — that's a real coverage signal, not a bug.
- **OpenOcean**: HTTP 200 wrapper `code: 200`, data `code: 0`, but `outAmount == "0"` or `dexId < 0` or `path == null` or `price_impact == "-100%"`. OpenOcean has no string error for no-route, so we read the payload.

## Metrics

```
solana_quote_latency_ms{provider, region}                    histogram — buckets 10, 25, 50, 100, 200, 500, 1000, 2000, 5000 ms (only on success)
solana_quote_success{provider, region}                       gauge 0|1 — last cycle outcome
solana_quote_throttled_total{provider, region}               counter   — HTTP 429
solana_quote_auth_error_total{provider, region}              counter   — HTTP 401/403
solana_quote_no_route_total{provider, region}                counter   — liquidity-gap failures
solana_quote_other_error_total{provider, region, error_type} counter   — everything else
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
| `MOBULA_API_KEY` | (required) | Required to probe Mobula AND to fetch the trending rotation list. Sent as raw `Authorization: <key>` header (no Bearer prefix). |
| `JUPITER_API_KEY` | (unset) | Optional. The lite endpoint works without a key. |
| `DFLOW_API_KEY` | (unset) | Reserved. DFlow adapter is a stub pending partnership API access. |
| `LOGS_TOKEN` | (unset) | Optional, gates `GET /logs?tail=N` (404 when unset). |

## Endpoints

| Path | Description |
|---|---|
| `GET /metrics` | Prometheus scrape target |
| `GET /health` | Returns `200 OK` |
| `GET /logs?tail=N` | Last 5000 lines of stdout (ring buffer). Requires `X-Logs-Token: $LOGS_TOKEN` |

## Design notes

- **Token rotation, not a canonical pair.** Anchoring the bench to SOL → USDC (or any single popular pair) meant we were comparing edge caches, not routing. The trending list rotation forces every provider to actually search a path.
- **Warm-path measurement.** Each provider keeps one `http.Client` for the life of the process and reuses TCP + TLS across ticks. We measure steady-state RTT, not the first-call cold-start.
- **10 s per-request timeout.** Slow responses are recorded as `other_error{error_type="timeout"}`, not as 10 s latency samples.
- **60 s tick.** ≈ 1,440 samples per provider per region per day, with each tick targeting a different token from the ~40-token rotation list.
- **Histogram-only buckets.** No quantile is computed inside the harness; the bench YAML uses `histogram_quantile()` on Prometheus's side over a 24-hour window. This keeps the percentiles correct across restarts and replicas.
- **Region is hosted, not virtual.** Three Railway services in three regions each run this binary with their own `MONITOR_REGION` env.

## Reproducibility

Public quote endpoints. A Mobula API key is free (`https://mobula.io/api`). Anyone can clone, run, and reproduce the numbers on the bench page.
