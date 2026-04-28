# Harness · aggregator-quote

> Issues swap-quote requests to DEX aggregators on a fixed cadence and records latency + success.

**Bench**: [№ 001 · DEX Aggregator — Quote Latency](../../benchmarks/aggregator-quote-latency.yml)

## What it measures

- **Latency** — wall-clock time from request emission to a usable JSON response.
- **Success rate** — share of requests that returned a quote within the 5,000 ms timeout.
- **Sample count** — total requests issued, per provider, per region.

## Providers

`mobula` · `1inch` · `0x` · `paraswap` · `kyberswap` · `jupiter`

## Inputs

- 40-pair set spanning blue-chips, mid-caps and stable→stable. List is committed in `pairs.json`.
- Trade size: $1,000 notional, normalised against the pair's reference price.
- Cadence: 1 request / pair / region every 30 s.
- Regions: `us-east-1`, `eu-west-1`, `ap-southeast-1`.

## Metrics emitted

```
ocb_quote_duration_ms_bucket{provider, region, le}
ocb_quote_duration_ms_sum{provider, region}
ocb_quote_duration_ms_count{provider, region}
ocb_quote_total{provider, region, success="true|false"}
```

## Env vars

| Var                  | Required | Notes                              |
| -------------------- | -------- | ---------------------------------- |
| `MOBULA_API_KEY`     | yes      | https://mobula.io/dashboard/api    |
| `INCH_API_KEY`       | yes      | https://portal.1inch.dev           |
| `ZRX_API_KEY`        | yes      | https://0x.org/docs/introduction   |
| `PARASWAP_API_KEY`   | optional | public endpoints work without it   |
| `KYBERSWAP_API_KEY`  | optional |                                    |
| `JUPITER_API_KEY`    | optional |                                    |
| `PUSHGATEWAY_URL`    | yes      | `https://pushgateway.openchainbench.xyz` (placeholder) |
| `REGION`             | yes      | one of the three above             |

## Running locally

> Not yet implemented — this folder is currently a contract placeholder.
> Open a PR to submit the actual runner.

```bash
make run        # in production: `make run REGION=eu-west`
```
