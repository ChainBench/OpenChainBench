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

The Prometheus URL declared in the YAML spec is what the OpenChainBench site queries — the harness pushes here and the site reads from the same instance.

## Run locally

Prerequisites: Go 1.24+, Docker, API keys for the aggregators you want to track.

```bash
cp .env.example .env
# Fill in the keys (any missing key disables that aggregator's monitor)
docker-compose up -d
```

Access:

- Grafana: <http://localhost:3000> (admin / admin)
- Prometheus: <http://localhost:9090>
- Metrics endpoint: <http://localhost:2112/metrics>

If the YAML spec at `benchmarks/aggregator-head-lag.yml` is repointed at `http://localhost:9090`, the OpenChainBench site rendered with `pnpm dev` will display your local data instead of production.

## Run on Railway

The deployed services live in this repo at `harnesses/aggregator-head-lag/`. To deploy:

1. Create three services on Railway from this repo, root directory `harnesses/aggregator-head-lag/`:
   - **monitor** — uses `Dockerfile`
   - **prometheus** — root `harnesses/aggregator-head-lag/prometheus`, uses `Dockerfile`
   - **alertmanager** — Docker image `prom/alertmanager:latest`, mounts `monitoring/alertmanager.yml`
2. Set environment variables on the monitor service (see `.env.example`).
3. Point the corresponding YAML's `prom_url` at the public Prometheus URL.

## Environment variables

| Var | Description | Required |
| --- | --- | --- |
| `MOBULA_API_KEY` | Mobula API key | optional |
| `COINGECKO_API_KEY` | CoinGecko Pro key (for GeckoTerminal feed) | optional |
| `DEFINED_SESSION_COOKIE` | Defined.fi session cookie (for Codex). Auto-scraped if absent. | optional |
| `MOBULA_WS_URL` | Override the Mobula WS endpoint | optional |
| `MONITOR_REGION` | Label written on every metric (e.g. `us-east`) | recommended |
| `GF_SECURITY_ADMIN_PASSWORD` | Grafana admin password (Docker only) | recommended |

A monitor with no key for a given aggregator is skipped cleanly — the harness will run for whatever providers it can authenticate with.

## Project layout

```
cmd/script/                Single Go binary: all monitors + Prometheus exporter
  ├── main.go              Entrypoint, supervises goroutines per aggregator
  ├── config.go            Env-var loader
  ├── metrics.go           Prometheus metric definitions + registration
  ├── head_lag_monitor.go  WebSocket monitor: on-chain ↔ feed timestamp delta
  ├── mobula_*.go          Mobula REST + WS monitors
  ├── codex_*.go           Codex REST monitor
  ├── geckoterminal_monitor.go
  ├── quote_api_monitor.go Mobula swap quoting latency
  ├── metadata_coverage_monitor.go
  ├── proxy.go             HTTP transport + retries
  └── log_buffer.go        In-memory ring buffer (last N log lines)

monitoring/                 Local docker-compose stack
  ├── prometheus.yml
  ├── alert_rules.yml
  ├── alertmanager.yml
  └── grafana/              Datasource + dashboards provisioning

prometheus/                 Production Prometheus (Railway service)
  ├── Dockerfile
  ├── prometheus.yml
  ├── prometheus.staging.yml
  └── alert_rules.yml

grafana/                    Production Grafana (Railway service)
  ├── Dockerfile
  ├── grafana-entrypoint.sh
  ├── dashboards/
  └── provisioning/

Dockerfile                  Monitor binary (multi-stage Go build)
docker-compose.yml          Local dev stack
Makefile                    `make run`, `make logs`, `make stop`, `make clean`
```

## Adding an aggregator

1. Create `cmd/script/<aggregator>_monitor.go` mirroring an existing file (e.g. `geckoterminal_monitor.go`).
2. Implement the WebSocket / REST loop and call `RecordLatency("<aggregator_name>", chain, latencyMs)` (or the appropriate metric registrar in `metrics.go`).
3. Add the API key field to `Config` in `config.go` and to `.env.example`.
4. Start the monitor goroutine in `main.go`.
5. Update the YAML spec at `benchmarks/aggregator-head-lag.yml` to reference the new aggregator under `providers:` and add its query under `prometheus.providers.<slug>`.
6. Add a Grafana panel if you want it visualised internally.

## Troubleshooting

```bash
# Are metrics being produced?
curl http://localhost:2112/metrics | grep head_lag_seconds

# Is Prometheus scraping?
open http://localhost:9090/targets    # all targets should be UP

# Restart the stack
docker-compose down && docker-compose up -d --build

# Tail monitor logs
docker-compose logs -f monitor
```

If a specific aggregator silently emits nothing: most often the API key is missing or rate-limited. Check the monitor logs for `[AGGREGATOR][skip]` lines.

## License

MIT — same as the rest of OpenChainBench.
