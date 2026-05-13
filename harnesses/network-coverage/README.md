# network-coverage

Bench № 005 — counts the chains/networks each onchain data provider officially supports.

A single Go binary that fetches the public "supported networks" listing from each provider every 6h and exposes the counts as Prometheus gauges. Powers `/benchmarks/network-coverage` on openchainbench.com.

## What it measures

```
networks_supported_total{provider="geckoterminal"}   ~ 150
networks_supported_total{provider="mobula"}          ~  45
networks_supported_total{provider="codex"}           ~  40
```

Plus a `network_supported{provider, chain_id, slug, name}` gauge that flips to 1 for each network in the listing — useful for diff queries on the site.

## Sources

| Provider | Endpoint | Auth |
| --- | --- | --- |
| GeckoTerminal | `GET /api/v2/networks?page=N` | none |
| Mobula | `GET /api/1/blockchains` | `Authorization: <api-key>` |
| Codex | GraphQL `getNetworks` at `https://graph.codex.io/graphql` | Bearer JWT minted from Defined.fi session cookie |

All endpoints are public — no scraping, no provider-specific deal.

## Run locally

```bash
cp .env.example .env
# fill MOBULA_API_KEY, DEFINED_SESSION_COOKIE
go run ./cmd/script/
```

`/metrics` will be exposed on `http://localhost:2112/metrics`. Other endpoints:

- `GET /metrics` — Prometheus scrape
- `GET /logs?tail=N` — last N lines of the in-memory log ring (5000 max)
- `GET /debug/networks` — last fetch snapshot per provider (count, sample of 5 networks, raw response sample of 400 chars, latency)
- `GET /health` — `OK`

## Run on Railway

Deploy from the OpenChainBench monorepo, root directory `miniapps/network-coverage/`. Set the env vars listed in `.env.example`. The shared `openchainbench-monitoring` Prometheus picks it up via Railway internal DNS automatically once a scrape job is added to `prometheus.yml`.

## Why this bench is honest

- Endpoints are public — anyone can verify the count by hitting them
- Comparing only mainnet networks (testnet inclusion is opt-in via `INCLUDE_TESTNETS=true`)
- Counts what a provider _claims_ to support — quality of coverage (token presence, metadata) is a separate bench
