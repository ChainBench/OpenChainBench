<div align="center">

![Aggregator Latency Benchmark](./assets/logo.png)

Real-time monitoring tool for tracking blockchain data indexation latency across multiple aggregators.

</div>

## How It Works

The monitor connects to aggregator WebSocket feeds and measures latency by comparing:
- When a trade occurs on-chain (from the event timestamp)
- When the aggregator pushes the event via WebSocket (current time)

Metrics are exposed via Prometheus and visualized in Grafana dashboards.

**Tracked Aggregators**: GeckoTerminal, Mobula, Codex
**Supported Chains**: Solana, Ethereum, BNB Chain, Base

## Quick Start

### Prerequisites

- Go 1.24+
- Docker & Docker Compose
- API keys from aggregators you want to track

### Run Locally

```bash
# Clone the repository
git clone git@github.com:MobulaFi/aggregator-latency-benchmark.git
cd aggregator-latency-benchmark

# Create .env file with your API keys
cp .env.example .env
# Edit .env with your keys

# Start everything with Docker Compose
docker-compose up -d
```

### Access Dashboards

- **Grafana**: http://localhost:3000 (admin/admin)
- **Prometheus**: http://localhost:9090
- **Metrics**: http://localhost:2112/metrics

## Deploy to Railway

### One-Click Deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/aggregator-latency-benchmark)

### Manual Deploy

1. Create a new project on [Railway](https://railway.app)
2. Add services from GitHub repo `MobulaFi/aggregator-latency-benchmark`:
   - **Monitor** (uses Dockerfile)
   - **Prometheus** (Docker image: `prom/prometheus`)
   - **Grafana** (Docker image: `grafana/grafana`)

3. Set environment variables for the Monitor service:
   ```
   COINGECKO_API_KEY=your_coingecko_api_key
   MOBULA_API_KEY=your_mobula_api_key
   DEFINED_SESSION_COOKIE=your_defined_session_cookie
   ```

4. Set environment variables for Grafana:
   ```
   GF_SECURITY_ADMIN_PASSWORD=your_secure_password
   GF_AUTH_ANONYMOUS_ENABLED=true
   GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer
   ```

5. Configure networking between services (Railway handles this automatically with internal DNS)

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `COINGECKO_API_KEY` | CoinGecko Pro API key | Optional |
| `MOBULA_API_KEY` | Mobula API key | Optional |
| `DEFINED_SESSION_COOKIE` | Defined.fi session cookie (for Codex data) | Optional |
| `GF_SECURITY_ADMIN_PASSWORD` | Grafana admin password | Recommended |

If an API key is not provided, that specific monitor will be skipped.

## Project Structure

```
aggregator-latency-benchmark/
├── cmd/
│   ├── script/          # Main latency monitor
│   │   ├── main.go
│   │   ├── config.go
│   │   ├── metrics.go
│   │   ├── geckoterminal_monitor.go
│   │   ├── mobula_monitor.go
│   │   └── codex_monitor.go
│   └── pulse/           # Pool discovery monitor
│       └── ...
├── monitoring/
│   ├── prometheus.yml
│   └── grafana/
│       ├── provisioning/
│       └── dashboards/
├── Dockerfile
├── docker-compose.yml
├── railway.json
├── Makefile
└── .env.example
```

## Adding a New Aggregator

1. Create `cmd/script/youraggregator_monitor.go`
2. Implement WebSocket connection and message handling
3. Call `RecordLatency("aggregator_name", chain, latencyMs)`
4. Add API key to `.env` and `config.go`
5. Start monitor in `main.go`
6. Update Grafana dashboard with new metrics

See existing monitor files for implementation examples.

## Local Development

```bash
# Build only
make build

# Run monitors locally (without Docker)
make run

# View logs
make logs

# Stop all services
make stop

# Clean everything
make clean
```

## Troubleshooting

### No data in Grafana

```bash
# Check if metrics are exposed
curl http://localhost:2112/metrics | grep latency

# Check Prometheus targets
# Go to http://localhost:9090/targets - should show "UP"

# Restart everything
docker-compose down && docker-compose up -d
```

### WebSocket connection failed

- Verify API key in environment variables
- Check if API key has WebSocket access
- Look for errors in container logs: `docker-compose logs monitor`

### Docker errors

```bash
# Full reset
docker-compose down -v
docker-compose up -d --build
```

## License

MIT
