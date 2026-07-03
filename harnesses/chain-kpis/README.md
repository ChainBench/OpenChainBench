# chain-kpis

Per-chain KPI exporter for the OCB `/chains/<slug>` page strip.

## What it does

Polls DefiLlama and Mobula on a fixed cadence, computes the OCB-canonical
per-chain KPI set, and exposes Prometheus gauges on `:2112/metrics` that
the OCB site reads from on every SSR render of `/chains/<slug>`.

## Sources & gauges

| Gauge | Source | Cadence |
|---|---|---|
| `chain_tvl_usd{chain}` | DefiLlama `/v2/historicalChainTvl/<name>` | 15 min |
| `chain_dex_volume_24h_usd{chain}` | DefiLlama `/overview/dexs/<name>` | 15 min |
| `chain_stables_mcap_usd{chain}` | DefiLlama `/stablecoincharts/<name>` | 15 min |
| `chain_native_price_usd{chain, symbol}` | Mobula `/api/1/market/data?symbol=<sym>` | 5 min |
| `chain_native_mcap_usd{chain, symbol}` | Mobula `/api/1/market/data?symbol=<sym>` | 5 min |
| `chain_mobula_tokens_indexed{chain}` | Mobula `/api/1/market/blockchain/stats?blockchain=<name>` | 5 min |

Plus observability:
- `chain_kpis_last_refresh_timestamp_seconds{chain, source}`
- `chain_kpis_fetch_latency_milliseconds{chain, source}`
- `chain_kpis_fetch_errors_total{chain, source, error_type}`
- `chain_kpis_last_tick_unix`

## Chain registry

The set of chains (slug, DefiLlama name, Mobula name, native symbol) is
hardcoded in `cmd/script/registry.go`. It MUST mirror the OCB site's
`src/lib/chains.ts` registry. Adding a new chain:

1. Append to `Registry` in `cmd/script/registry.go`
2. Append to `CHAINS` in `src/lib/chains.ts` on the OCB site
3. Redeploy both

Names were verified live against DefiLlama `/v2/chains` and Mobula
`/api/1/blockchains`. Empty `DefiLlama`/`Mobula` fields = source confirmed
unsupported for that chain (e.g. Monero on DefiLlama; Stellar, Cardano,
Litecoin, Monero on Mobula). The page renders only the cards with data.

## Env vars

| Var | Default | Required |
|---|---|---|
| `MOBULA_API_KEY` | (empty) | Required for `mobula-native` and `mobula-stats` fetchers; without it the harness logs a warning and skips Mobula. DefiLlama still works. |
| `DEFILLAMA_REFRESH_MINUTES` | `15` | Optional override. |
| `MOBULA_REFRESH_MINUTES` | `5` | Optional override. |

## Port

Hardcoded `:2112` per the OCB harness convention. The shared Prom-gateway
on Railway is configured to scrape `:2112` from every OCB harness. Do not
listen on `$PORT` — Railway sets that env var for its proxy layer; the
harness ignores it.

## Graceful degradation

- DefiLlama 404 / empty body for a chain → that chain's gauge is left
  untouched (Prom carry-forward); a `chain_kpis_fetch_errors_total`
  counter is incremented with `error_type="not_tracked"` or
  `error_type="not_found"` so dashboards can distinguish genuine outages
  from expected gaps.
- Mobula 429 / 401 → all chains for that fetcher are skipped this tick;
  DefiLlama keeps publishing.
- One chain failure does not affect any other chain (each fetch is its
  own goroutine).

## Local run

```bash
MOBULA_API_KEY=… \
DEFILLAMA_REFRESH_MINUTES=60 \
MOBULA_REFRESH_MINUTES=60 \
go run ./cmd/script

# In another terminal:
curl -s http://localhost:2112/metrics | grep '^chain_' | head
```
