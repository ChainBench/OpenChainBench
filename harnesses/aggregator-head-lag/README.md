# Harness · aggregator-head-lag

> Real-time monitor that produces the `head_lag_seconds` metric consumed by [`benchmarks/aggregator-head-lag.yml`](../../benchmarks/aggregator-head-lag.yml). One Go binary, one Railway service, one benchmark.

**Bench**: [№ 001 · Aggregator Head Lag](../../benchmarks/aggregator-head-lag.yml)

## How it works

Connects to each aggregator's WebSocket / REST feed and measures latency by comparing:

- The on-chain timestamp of a trade event (from the event payload)
- The wall-clock time at which the aggregator emitted the event

The delta is exported as a Prometheus gauge (`head_lag_seconds`), labelled by aggregator, chain and region. Failures surface as `head_lag_errors_total` counters.

**Tracked aggregators**: GeckoTerminal · Mobula · Codex
**Supported chains**: Solana · Ethereum · BNB Chain · Base

## Where the data goes

This harness is a data producer only. It exposes `/metrics` on port `2112`. The shared OpenChainBench Prometheus (see [`/infrastructure/prometheus`](../../infrastructure/prometheus)) scrapes that endpoint:

```
aggregator-head-lag.railway.internal:2112 ──► prometheus.railway.internal ──► public site
```

## Metrics produced

```
head_lag_seconds{aggregator, chain, region}                       gauge
head_lag_milliseconds{aggregator, chain, region}                  gauge (× 1000 of seconds)
head_lag_errors_total{aggregator, chain, region, error_type}      counter
mobula_head_lag_detailed_seconds{aggregator, chain, region, pool} gauge
mobula_processing_lag_seconds{...}                                gauge
mobula_network_lag_seconds{...}                                   gauge
aggregator_head_block{aggregator, chain, region}                  gauge
blockchain_head_block{chain, region}                              gauge
```

## Run locally

Prerequisites: Go 1.24+, API keys for the aggregators you want to track.

```bash
cp .env.example .env
# Fill in MOBULA_API_KEY, COINGECKO_API_KEY, DEFINED_SESSION_COOKIE
go run ./cmd/script/
```

`/metrics` will be exposed on `http://localhost:2112/metrics`.

Or via Docker:

```bash
docker build -t aggregator-head-lag .
docker run --rm --env-file .env -p 2112:2112 aggregator-head-lag
```

## Run on Railway

This service is deployed from the OpenChainBench repo, root directory `harnesses/aggregator-head-lag/`. Set the env vars listed below and the shared Prometheus picks it up via DNS.

## Environment variables

| Var | Description | Required |
| --- | --- | --- |
| `MOBULA_API_KEY` | Mobula API key | optional |
| `COINGECKO_API_KEY` | CoinGecko Pro key (for GeckoTerminal feed) | optional |
| `DEFINED_SESSION_COOKIE` | Defined.fi session cookie (for Codex). Auto-scraped if absent. | optional |
| `MOBULA_WS_URL` | Override the Mobula WS endpoint | optional |
| `MONITOR_REGION` | Label written on every metric (e.g. `us-east`) | recommended |

A monitor with no key for a given aggregator is skipped cleanly.

## Project layout

```
cmd/script/                Single Go binary
  ├── main.go              Boots the head-lag goroutine + metrics server
  ├── config.go            Env-var loader
  ├── metrics.go           Prometheus metric definitions
  ├── head_lag_monitor.go  WebSocket monitor: on-chain ↔ feed timestamp delta
  ├── mobula_fast_trade_monitor.go  Mobula-specific lag breakdown
  ├── proxy.go             HTTP transport + retries
  └── log_buffer.go        In-memory ring buffer
```

## License

MIT, same as the rest of OpenChainBench.
