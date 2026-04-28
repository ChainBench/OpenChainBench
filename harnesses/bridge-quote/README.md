# Harness · bridge-quote

> Issues identical cross-chain quote requests to bridge APIs and records latency + success.

**Bench**: [№ 002 · Bridge Quote Latency](../../benchmarks/bridge-quote-latency.yml)

## What it measures

- **Quote latency** — wall-clock time from request emission to a usable cross-chain quote response.
- **Success rate** — share of requests that returned a valid quote within the 5,000 ms timeout.

## Bridges

`mobula` · `relay` · `lifi` · `debridge`

## Inputs

- Routes: USDC pairs spanning Solana, Base and Arbitrum.
- Notional sizes: $5, $50, $300.
- Cadence: full sweep (4 routes × 3 amounts × N bridges) every 5 minutes.
- Region: currently `eu-west` only.

## Metrics emitted

```
bridge_quote_latency_ms_{bucket,sum,count}{bridge, from_chain, to_chain, from_token, to_token, amount_usd, region}    histogram
bridge_quote_success{bridge, from_chain, to_chain, from_token, to_token, amount_usd, region}                          gauge 0/1
bridge_errors_total{bridge, from_chain, to_chain, from_token, to_token, amount_usd, region, error_type}               counter
bridge_estimated_time_ms{bridge, ...}                                                                                  gauge
```

## Env vars

| Var                   | Required | Notes                              |
| --------------------- | -------- | ---------------------------------- |
| `MOBULA_API_KEY`      | yes      | https://mobula.io/dashboard/api    |
| `LIFI_API_KEY`        | optional | public endpoints work without it   |
| `RELAY_API_KEY`       | optional |                                    |
| `DEBRIDGE_API_KEY`    | optional |                                    |
| `PROMETHEUS_PUSH_URL` | yes      | Prometheus push gateway            |
| `MONITOR_REGION`      | yes      | one of `us-east`, `eu-west`, `sgp` |

## Running locally

> Implementation TBD. See the spec YAML for the queries the site issues
> against the metrics emitted by this harness.

```bash
make run REGION=eu-west
```
