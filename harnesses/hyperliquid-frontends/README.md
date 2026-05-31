# hyperliquid-frontends harness

OpenChainBench bench № 030 — quality benchmark of Hyperliquid frontends, ranked by **how much they extract from users**, not by raw volume share.

## What it measures

Three quality metrics per builder, refreshed hourly from the public daily fills dumps Hyperliquid publishes at `https://stats-data.hyperliquid.xyz/Mainnet/builder_fills/{address}/{YYYYMMDD}.csv.lz4`:

| Metric | Definition |
|---|---|
| **Effective fee bps** | `sum(builder_fee) / sum(notional) × 10 000` — volume-weighted average over 24 h |
| **$ per user** | `sum(builder_fee) / count(distinct user)` — raw efficiency per active trader |
| **Fee discipline** | `stddev_over_time(effective_fee_bps[30d])` — computed in Prometheus, surfaces rotating-promo cycles |

Headline ranking = lowest effective fee = most aligned with traders.

Why this framing: the Hyperliquid frontend wars already have a dozen volume-share dashboards (ASXN HyperScreener, Coinmarketman HyperTracker, Flowscan, Allium, Hyperdash, several Dune boards). What nobody publishes cleanly is the user-cost side. This bench is the user-cost side.

## Builder registry

`builders.json` is a hand-curated `[{slug, name, address, valid_from, notes}]` array. Addresses are cross-referenced against:
- Flowscan `/builders` — live leaderboard
- Hyperliquid governance forum disclosures
- Each frontend's public announcement of their builder code

**The committed file ships with placeholder `0x0000…` addresses.** They MUST be filled in before the harness can fetch anything useful. The harness will return `403` for every placeholder address (the Hyperliquid bucket returns 403 when the date file doesn't exist for that address).

Workflow for adding / updating addresses:
1. Pull the latest Flowscan builders list, cross-check with ASXN's published mapping
2. Edit `builders.json`, bump `valid_from` to today
3. PR with a Flowscan screenshot in the description so the registry change is auditable
4. After merge, redeploy the harness on Railway

## Prometheus metrics emitted

```
hl_frontend_effective_fee_bps{builder}                    gauge
hl_frontend_fees_per_user_usd{builder}                    gauge
hl_frontend_volume_usd_24h{builder}                       gauge
hl_frontend_users_24h{builder}                            gauge
hl_frontend_fills_total{builder}                          gauge
hl_frontend_unattributed_share_pct                        gauge
hl_frontend_registry_age_seconds                          gauge
hl_frontend_csv_fetch_status_total{builder,code}          counter
```

Bench page column mapping is documented in `benchmarks/hyperliquid-frontends.yml` — p50 / p90 / p99 are repurposed for effective fee / 30d stddev / $/user respectively since the unit is bps and there is no native percentile semantics.

## Run locally

```bash
cd harnesses/hyperliquid-frontends
go run ./cmd/script
curl http://localhost:2112/metrics | grep hl_frontend_
```

## Deploy

Standard OCB-miniapp shape — multi-stage Dockerfile, port 2112, scraped by the shared `openchainbench-monitoring` Prometheus via `hyperliquid-frontends.railway.internal:2112`.

After deploy, add a scrape config entry:

```yaml
- job_name: 'hyperliquid-frontends'
  static_configs:
    - targets:
        - 'hyperliquid-frontends.railway.internal:2112'
      labels:
        benchmark: hyperliquid-frontends
  metrics_path: /metrics
```

## Known limits

- **Daily granularity** — the CSV bucket only rolls at UTC midnight. Intra-day movement is invisible. A v1.1 upgrade would consume the WebSocket `userFills` stream filtered on the `b` field for realtime.
- **Native HL UI excluded** — orders without a builder code are not attributable here. Covered by the separate `/benchmarks/aggregator-head-lag` bench.
- **Wash trading** — fills are taken at face value. A frontend running wash flow shows up exactly as the chain records. Mitigation = the unique-user column flags anomalous low-user / high-volume signatures. A sybil-cluster heuristic ships in v1.1.
- **Registry maintenance** — the builder address list is hand-curated. The `hl_frontend_unattributed_share_pct` metric makes the coverage gap visible; an alert fires when it crosses 2 %.
