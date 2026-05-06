# Harness · network-coverage

> Counts the chains/networks each onchain data provider officially supports. Produces the metrics consumed by [`benchmarks/network-coverage.yml`](../../benchmarks/network-coverage.yml).

**Bench**: [№ 005 · Onchain data providers](../../benchmarks/network-coverage.yml)

## How it works

A single Go binary calls each provider's public "supported networks" listing every six hours and exposes the counts as Prometheus gauges:

```
networks_supported_total{provider="geckoterminal"} 263
networks_supported_total{provider="codex"}         133
networks_supported_total{provider="mobula"}         78
```

Plus a `network_supported{provider, chain_id, slug, name}` gauge that flips to `1` for each chain the provider currently lists. useful for a per-chain diff view on the site (e.g. "which chains is Codex missing that Gecko has?").

**Tracked providers**: GeckoTerminal · Codex · Mobula

## Sources

| Provider | Endpoint | Auth |
| --- | --- | --- |
| GeckoTerminal | `GET /api/v2/networks?page=N` | none |
| Codex | GraphQL `getNetworks` at `https://graph.codex.io/graphql` | API key (`CODEX_API_KEY`, free tier at https://dashboard.codex.io) |
| Mobula | `GET /api/1/blockchains` | `Authorization: <api-key>` |

All endpoints are public. no scraping, no provider-specific deal.

## Where the data goes

This harness is a **data producer only**. it exposes `/metrics` on port `2112`. The OpenChainBench Prometheus scrapes that endpoint over Railway's internal DNS:

```
network-coverage.railway.internal:2112 ──► prometheus.railway.internal ──► public site
```

## Run locally

```bash
cp .env.example .env
# Fill MOBULA_API_KEY, CODEX_API_KEY (or DEFINED_SESSION_COOKIE for the legacy path)
go run ./cmd/script/
```

`/metrics` will be exposed on `http://localhost:2112/metrics`.

Or via Docker:

```bash
docker build -t network-coverage .
docker run --rm --env-file .env -p 2112:2112 network-coverage
```

## Endpoints exposed

| Endpoint | What |
| --- | --- |
| `GET /metrics` | Prometheus scrape |
| `GET /logs?tail=N` | Last N lines of the in-memory log ring (5000 max). If `LOGS_TOKEN` is set, requires header `X-Logs-Token` |
| `GET /debug/networks` | JSON snapshot per provider. count, sample of 5 networks, raw response sample (400 chars), latency, error if any |
| `GET /health` | Liveness probe |

The debug endpoint is meant for production troubleshooting. when a provider's count drops or stalls, hit `/debug/networks` to see the exact response their API returned.

## Environment variables

| Var | Description | Required |
| --- | --- | --- |
| `MOBULA_API_KEY` | Mobula API key (Authorization header) | yes (else Mobula skipped) |
| `CODEX_API_KEY` | Codex official API key from dashboard.codex.io | recommended |
| `DEFINED_SESSION_COOKIE` | Legacy auth path. mints a JWT from defined.fi/api when CODEX_API_KEY is unset | optional |
| `DEFINED_TOKEN_SERVICE_URL` | Optional sidecar URL serving pre-minted JWTs | optional |
| `HTTP_PROXY` / `HTTPS_PROXY` | Webshare rotating proxy (only used by the legacy mint path) | only with cookie path |
| `REFRESH_INTERVAL_MINUTES` | Seconds between refreshes (default 360 = 6h) | optional |
| `LOGS_TOKEN` | Bearer for `/logs` (leave empty to make it open) | optional |

## Why this bench

Onchain data providers compete on three axes. coverage breadth, freshness, metadata completeness. Existing benches (№ 001 head lag, № 004 metadata coverage) test the latter two. This one tests the first, and is the bench Mobula loses by design: GeckoTerminal lists ~263 networks, Codex ~133, Mobula ~78. Builders comparing providers should weigh all three.

## License

MIT. same as the rest of OpenChainBench.
