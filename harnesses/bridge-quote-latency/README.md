# Harness · bridge-quote-latency

> Bridge quote-latency monitor that produces `bridge_quote_latency_ms_*` metrics consumed by [`benchmarks/bridge-quote-latency.yml`](../../benchmarks/bridge-quote-latency.yml). One Go binary, one Railway service, one benchmark.

**Bench**: [№ 002 · Bridge Quote Latency](../../benchmarks/bridge-quote-latency.yml)

**Tracked bridges**: Mobula · Relay · Li.Fi · Debridge

## How it works

Quote loop runs every 5 minutes: for every route × every notional ($5 / $50 / $300), each bridge is queried and the wall-clock time to receive a usable quote is recorded as a histogram observation.

The same quote loop emits cost metrics consumed by the sibling `bridge-fee` harness, but that benchmark is served by its own service so the two stay independent.

## Metrics produced (subset relevant to this bench)

```
bridge_quote_latency_ms_{bucket,sum,count}{bridge, from_chain, to_chain, from_token, to_token, amount_usd, region}   histogram
bridge_quote_success{bridge, ...}                  gauge 0/1
bridge_errors_total{bridge, error_type, ...}       counter
```

## Run locally

```bash
cp .env.example .env
docker-compose -f deploy/docker-compose.yml up -d
```

Or directly:

```bash
go run ./cmd/monitor/
# /metrics on :9090
```

## Environment variables

| Var | Required | Notes |
| --- | --- | --- |
| `MOBULA_API_KEY` | yes | Quotes |
| `LIFI_API_KEY` | recommended | Better rate limits |
| `EXECUTION_MODE` | yes | `dry-run` (recommended for this service) |
| `MONITOR_REGION` | yes | Metric label |

## License

MIT.
