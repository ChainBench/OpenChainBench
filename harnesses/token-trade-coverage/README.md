# Harness · token-trade-coverage

> Source for bench № 090 · Most complete onchain trade data API. Measures, for each reference token per chain, how many trades each provider (Mobula, Bitquery, Codex, Moralis) returns in a fixed 60-minute window, then publishes the capture rate vs the union baseline.

## What ships in this directory

- `cmd/scanner/main.go` — measurement loop. Every `SWEEP_SEC` (default 1800 = 30 min) it iterates every (provider, chain, token) tuple, fetches trades in the same 60-minute window, computes the union baseline as `max(counts across providers)` and emits per-provider capture rate to Prometheus.
- `cmd/scanner/mobula.go`, `bitquery.go`, `codex.go`, `moralis.go` — one file per provider. Each exposes a single `fetchTrades(ctx, chain, tokenAddress, windowStart, windowEnd) (int, error)` function that returns the number of distinct trades. Not the full trade objects — we only need the count for capture-rate computation, so the harness never materializes hundreds of MB of trade JSON in memory.
- `cmd/scanner/config.go` — reference token list per chain, env parsing, provider capability matrix (which provider supports which chain).
- `cmd/scanner/metrics.go` — Prom metric definitions (`ocb_token_trade_capture_pct`, `ocb_token_trade_probe_ok`, `ocb_token_trade_query_latency_ms`, `ocb_token_trade_dex_count`).

## Providers

| Provider | Endpoint | Auth | Chains |
| --- | --- | --- | --- |
| Mobula | `GET /api/2/trades/filters` | `Authorization: <key>` | Solana, Ethereum, BSC, Base, Stellar |
| Bitquery | `POST /graphql` (streaming.bitquery.io) | `X-API-KEY` header | Solana, Ethereum, BSC, Base |
| Codex | `POST /graphql` (graph.codex.io) | `Authorization: <key>` | Solana, Ethereum, BSC, Base |
| Moralis | `GET /token/mainnet/{addr}/swaps` (Solana) or `GET /erc20/{addr}/swaps` (EVM) | `X-API-Key` | Solana, Ethereum, BSC, Base |

Stellar is measured for Mobula only (the other three do not ship a public Stellar trades endpoint at time of writing). The bench renders Stellar coverage as a per-chain view where non-supporting providers are absent from the row, not counted as zero.

## Reference tokens

Chosen for meaningful trade activity in the measurement window so a coverage gap is visible above sampling noise. See `config.go` for the current list. Rotated periodically to avoid a single token going illiquid and dragging every provider's absolute count to zero.

## Cadence

`SWEEP_SEC=1800` (30 min). One full sweep does 4 providers × 5 chains × 2 tokens = up to 40 API calls (fewer when a provider does not support a chain). Each call is bounded by `HTTP_TIMEOUT_SEC=30`. A full sweep completes well inside 30 minutes so `SWEEP_SEC` cadence and `avg_over_time(...[24h])` on the spec queries stay honest.

## Env vars

Required:

- `MOBULA_API_KEY` — Mobula API key. Contact mobula.io if you don't have one.
- `BITQUERY_API_KEY` — Bitquery streaming.bitquery.io key.
- `CODEX_API_KEY` — Codex (Defined) API key. NOTE: this bench does NOT use the cookie-based JWT flow from `aggregator-head-lag` because the query volume is high (batch historical, not live subscribe). Fresh dedicated key recommended.
- `MORALIS_API_KEY` — Moralis Web3 Data API key.

Optional:

- `SWEEP_SEC` (default 1800)
- `METRICS_PORT` (default 2112)
- `HTTP_TIMEOUT_SEC` (default 30)
- `LOG_LEVEL` (default info; set debug to log every provider call)

## Metrics produced

| Metric | Description |
| --- | --- |
| `ocb_token_trade_capture_pct{provider, chain, token}` | Capture rate percent (0-100). `provider_count / max_provider_count * 100`. Union baseline is per (chain, token) per cycle. |
| `ocb_token_trade_absolute_count{provider, chain, token}` | Raw trade count returned by that provider in the measurement window. |
| `ocb_token_trade_query_latency_ms{provider, chain, token}` | Wall-clock latency of the provider call, including pagination. |
| `ocb_token_trade_dex_count{provider, chain, token}` | Distinct DEX venues represented in the returned trade set. Companion metric — coverage breadth vs pure count. |
| `ocb_token_trade_probe_ok{provider, chain, token}` | 1 on successful fetch, 0 on error/timeout. Consumed by the spec's `success` query. |

The spec at `benchmarks/token-trade-coverage.yml` aggregates these across (chain, token) into a per-provider p50 for the headline leaderboard.

## Run locally

```bash
cp .env.example .env
# Fill in the four API keys
go run ./cmd/scanner/
```

`/metrics` at `http://localhost:2112/metrics`.

## Run in the OCB VPS stack

Add a service block in `/opt/ocb/docker-compose.yml`:

```yaml
  token-trade-coverage:
    build:
      context: /opt/ocb/harnesses/token-trade-coverage
      dockerfile: Dockerfile
    container_name: ocb-token-trade-coverage
    restart: unless-stopped
    env_file: /run/ocb/.env.token-trade-coverage
    expose: ["2112"]
    networks: [web]
    mem_limit: 512m
    cpus: "0.3"
```

Prometheus scrape config additions in `/opt/ocb/prometheus.yml`:

```yaml
  - job_name: token-trade-coverage
    scrape_interval: 60s
    static_configs:
      - targets: ["token-trade-coverage:2112"]
```

## Reference implementation

The initial TypeScript reference lives at https://github.com/Flotapponnier/token-trade-benchmark-. This harness is a Go port with Prometheus emission and OCB conventions. Any semantic drift between the two (which trades count, how the window is bounded) is corrected here first; the reference repo is a design document, not a source of truth.
