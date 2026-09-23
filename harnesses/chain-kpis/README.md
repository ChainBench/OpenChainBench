# chain-kpis

Per-chain KPI exporter for the OCB `/chains/<slug>` page strip.

## What it does

Polls DefiLlama, Mobula and L2Beat on a fixed cadence, computes the
OCB-canonical per-chain KPI set, and exposes Prometheus gauges on
`:2112/metrics` that the OCB site reads from on every SSR render of
`/chains/<slug>` and on bench 273 `chain-bridged-tvl`.

DefiLlama and Mobula are polled per chain. L2Beat is not: one request to
`/api/scaling/summary` carries every project it tracks, so that source
costs four requests an hour in total rather than four per chain, and the
result is fanned out over the registry rows that carry an L2Beat id.

## Sources & gauges

| Gauge | Source | Cadence |
|---|---|---|
| `chain_tvl_usd{chain}` | DefiLlama `/v2/historicalChainTvl/<name>` | 15 min |
| `chain_dex_volume_24h_usd{chain}` | DefiLlama `/overview/dexs/<name>` | 15 min |
| `chain_stables_mcap_usd{chain}` | DefiLlama `/stablecoincharts/<name>` | 15 min |
| `chain_native_price_usd{chain, symbol}` | Mobula `/api/1/market/data?symbol=<sym>` | 5 min |
| `chain_native_mcap_usd{chain, symbol}` | Mobula `/api/1/market/data?symbol=<sym>` | 5 min |
| `chain_mobula_tokens_indexed{chain}` | Mobula `/api/1/market/blockchain/stats?blockchain=<name>` | 5 min |
| `chain_tvs_usd{chain}` | L2Beat `/api/scaling/summary` | 15 min |
| `chain_value_secured_usd{chain, origin}` | L2Beat, `origin` = native / canonical / external | 15 min |
| `chain_bridged_tvl_usd{chain}` | L2Beat, derived: canonical + external | 15 min |
| `chain_tvs_change_7d_pct{chain}` | L2Beat `change7d` × 100 | 15 min |
| `chain_tvs_change_7d_excess_pct{chain}` | derived: the 7d move minus the cohort median | 15 min |
| `chain_tvs_cohort_median_7d_pct` | derived, no labels: median 7d move above the size floor | 15 min |
| `chain_tvs_cohort_size` / `_under_review` / `_layer3` | derived, no labels: the cohort's composition | 15 min |
| `chain_kpis_health{chain, source}` | 1 if the last fetch for that source returned data | per source |
| `chain_kpis_l2beat_last_success_unix` | freshness for bench 273, no labels | 15 min |

### Reading the L2Beat gauges

`chain_bridged_tvl_usd` is value that arrived from another chain; the
complement, `origin="native"`, was minted locally. The three origins
reconstruct the total, and the harness refuses to publish a row whose
origins miss the total by more than 0.1 % — if upstream renames a field,
every value binds to zero and a `$0` bridged TVL at full health would be a
wrong number that looks measured.

`chain_tvs_change_7d_excess_pct` is the metric to rank on, not the raw
change. In a broad up week every chain's raw number rises, so a raw
ranking ranks the market. The excess subtracts the median across every
live project above `L2BEAT_MEDIAN_FLOOR_USD` (default $200M); the median,
the cohort size and how much of it L2Beat has under review are published
so the subtraction can be checked. Below five projects no median is
published and the excess series is cleared rather than frozen.

Rows are the registry chains L2Beat tracks in its scaling summary. That is
not the same as "rollups": Polygon PoS, Gnosis and Hyperliquid run their
own consensus and are tracked. Settled L1s with no host chain carry no id.

### Env

| Var | Default | Effect |
|---|---|---|
| `DEFILLAMA_REFRESH_MINUTES` | 15 | DefiLlama cadence |
| `MOBULA_REFRESH_MINUTES` | 5 | Mobula cadence |
| `L2BEAT_REFRESH_MINUTES` | 15 | L2Beat cadence |
| `L2BEAT_MEDIAN_FLOOR_USD` | 200000000 | size floor for the median cohort |
| `MOBULA_API_KEY` | — | required for the Mobula gauges only |

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
