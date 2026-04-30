# Harness · aggregator-head-lag

> Real-time monitor that produces the `head_lag_seconds` metric consumed by [`benchmarks/aggregator-head-lag.yml`](../../benchmarks/aggregator-head-lag.yml).

**Bench**: [№ 001 · Aggregator Head Lag](../../benchmarks/aggregator-head-lag.yml)

## How it works

The monitor connects to each aggregator's WebSocket / REST feed and measures latency by comparing:

- The on-chain timestamp of a trade event (from the event payload)
- The wall-clock time at which the aggregator emitted the event

The delta is exported as a Prometheus gauge (`head_lag_seconds`), labelled by aggregator, chain and region. Failures surface as `head_lag_errors_total` counters. REST API latency, quote API latency and metadata coverage are recorded in parallel from the same process.

**Tracked aggregators**: GeckoTerminal · Mobula · Codex
**Supported chains**: Solana · Ethereum · BNB Chain · Base

## Where the data goes

This harness is a **data producer only** — it exposes `/metrics` on port `2112`. The shared OpenChainBench Prometheus (see [`/infrastructure/prometheus`](../../infrastructure/prometheus)) scrapes that endpoint over Railway's internal DNS:

```
aggregator-head-lag.railway.internal:2112 ──► prometheus.railway.internal ──► public site
```

A contributor running locally just needs `/metrics` reachable from their Prom scraper — nothing else.

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
rest_api_latency_milliseconds_{bucket,sum,count}{...}             histogram
quote_api_latency_milliseconds_{bucket,sum,count}{...}            histogram
metadata_coverage_total / metadata_coverage_success{...}          counter
```

## Run locally

Prerequisites: Go 1.24+, API keys for the aggregators you want to track.

```bash
cp .env.example .env
# Fill in the keys (any missing key disables that aggregator's monitor)
go run ./cmd/script/
```

`/metrics` will be exposed on `http://localhost:2112/metrics`. To exercise the OpenChainBench site against your local data, point the YAML spec's `prom_url` at a local Prometheus that scrapes this endpoint (the `infrastructure/prometheus` config has notes on how to do this).

Or run via Docker:

```bash
docker build -t aggregator-head-lag .
docker run --rm --env-file .env -p 2112:2112 aggregator-head-lag
```

## Run on Railway

This service is deployed from the OpenChainBench repo, root directory `harnesses/aggregator-head-lag/`. Set the env vars listed below, and the shared Prometheus will pick it up via DNS automatically.

## Environment variables

| Var | Description | Required |
| --- | --- | --- |
| `MOBULA_API_KEY` | Mobula API key | optional |
| `COINGECKO_API_KEY` | CoinGecko Pro key (for GeckoTerminal feed) | optional |
| `DEFINED_SESSION_COOKIE` | Defined.fi session cookie (for Codex). Auto-scraped if absent. | optional |
| `MOBULA_WS_URL` | Override the Mobula WS endpoint | optional |
| `MONITOR_REGION` | Label written on every metric (e.g. `us-east`) | recommended |

A monitor with no key for a given aggregator is skipped cleanly — the harness will run for whatever providers it can authenticate with.

## Project layout

```
cmd/script/                 Single Go binary — all monitors + Prometheus exporter
  ├── main.go               Entrypoint, supervises goroutines per aggregator
  ├── config.go             Env-var loader
  ├── metrics.go            Prometheus metric definitions + HTTP /metrics handler
  ├── head_lag_monitor.go   WebSocket monitor: on-chain ↔ feed timestamp delta
  ├── mobula_*.go           Mobula REST + WS monitors
  ├── codex_*.go            Codex REST monitor
  ├── geckoterminal_monitor.go
  ├── quote_api_monitor.go  Mobula swap quoting latency
  ├── metadata_coverage_monitor.go
  ├── proxy.go              HTTP transport + retries
  └── log_buffer.go         In-memory ring buffer (last N log lines)

Dockerfile                  Multi-stage Go build
.env.example                Documented env vars
```

## Adding an aggregator

1. Create `cmd/script/<aggregator>_monitor.go` mirroring an existing file (e.g. `geckoterminal_monitor.go`).
2. Implement the WebSocket / REST loop and call the appropriate `metrics.go` recorder.
3. Add the API key field to `Config` in `config.go` and to `.env.example`.
4. Start the monitor goroutine in `main.go`.
5. Update the YAML spec at `benchmarks/aggregator-head-lag.yml` to reference the new aggregator under `providers:` and add its query under `prometheus.providers.<slug>`.

## Troubleshooting

```bash
# Are metrics being produced?
curl http://localhost:2112/metrics | grep head_lag_seconds

# Tail logs (Docker)
docker logs -f <container>
```

If a specific aggregator silently emits nothing: most often the API key is missing or rate-limited. Check the logs for `[AGGREGATOR][skip]` lines.

## License

MIT — same as the rest of OpenChainBench.
