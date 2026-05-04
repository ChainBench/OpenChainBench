# Harness · metadata-coverage

> Token-metadata field-coverage monitor that produces the `metadata_coverage_*` metrics consumed by [`benchmarks/metadata-coverage.yml`](../../benchmarks/metadata-coverage.yml). One Go binary, one Railway service, one benchmark.

**Bench**: [№ 004 · Token Metadata Coverage](../../benchmarks/metadata-coverage.yml)

## How it works

Two goroutines inside one binary:

1. **Pulse V2 feeder** subscribes to Mobula's Pulse V2 WebSocket on Solana / BNB / Base and pushes freshly-launched launchpad tokens (pump.fun, Meteora DBC, Four.meme, Raydium CPMM, Zora, BaseApp, Bags, Moonshot) onto an in-memory queue.
2. **Metadata coverage worker** consumes the queue, queries each aggregator's metadata endpoint, and records whether four canonical fields (`logo`, `description`, `twitter`, `website`) are returned.

Pulse itself emits no benchmark metric. It is only used to discover fresh tokens.

**Tracked aggregators**: Mobula · Codex · Jupiter (Solana only)
**Tracked fields**: logo · description · twitter · website

## Metrics produced

```
metadata_coverage_checks_total{provider, chain, field, region}   counter
metadata_coverage_success_total{provider, chain, field, region}  counter
metadata_api_latency_milliseconds{provider, chain, region}       histogram
```

The bench page renders coverage % as `success_total / checks_total × 100`.

## Run locally

```bash
cp .env.example .env
# Fill in MOBULA_API_KEY, DEFINED_SESSION_COOKIE
go run ./cmd/script/
```

`/metrics` exposed on `http://localhost:2112/metrics`.

## Environment variables

| Var | Description | Required |
| --- | --- | --- |
| `MOBULA_API_KEY` | Mobula API key (Pulse V2 + token details) | yes |
| `DEFINED_SESSION_COOKIE` | Defined.fi session cookie (Codex GraphQL via JWT mint) | yes |
| `MONITOR_REGION` | Label written on every metric | recommended |

## License

MIT, same as the rest of OpenChainBench.
