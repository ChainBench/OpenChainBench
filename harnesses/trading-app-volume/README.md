# trading-app-volume

Cross-chain daily swap volume per trading app / Telegram bot on closed
UTC days, with the per-chain split, from DeFiLlama's free dexs summary.
Feeds bench 267 (`trading-app-daily-volume`), the `/trading-apps` hub chart
and the "Trading app" view on `/products/<slug>`.

## Why

The `/trading-apps` hub used one Dune community dataset per platform for
volume. Those datasets cover Solana only for FOMO, Trojan and Photon and
every chain for GMGN, Axiom and Terminal, so the column compared unlike
things (bench 208 keeps them, marked per platform). DeFiLlama's dexs
adapters for the *Trading App* and *Telegram Bot* categories are
cross-chain by construction and expose a per-chain breakdown per UTC day
on a free endpoint, so every row here is the app's total.

## Source

```
GET https://api.llama.fi/summary/dexs/<slug>?dataType=dailyVolume
  totalDataChart          [[unix, usd], ...]                  daily total
  totalDataChartBreakdown [[unix, {chain: {version: usd}}]]   per chain
```

One request per app per tick returns the whole history, so there is no
backfill: each tick re-reads every app, keeps the last `HISTORY_DAYS`
closed days and drops the open UTC day. DeFiLlama restates the last day
for about 24 h; the hourly re-read picks that up. A failed fetch keeps the
app's previous series and sets `error` on it.

Cohort (OCB slug → DeFiLlama slug): gmgn, axiom, fomo → fomo-wallet,
padre → terminal, pump-fun → pump.fun-mobile-app, photon, trojan, bullx,
bonkbot, banana-gun, bloom → bloom-trading-bot, soltradingbot, pepeboost,
o1-exchange → o1.exchange-trading-terminal. Maestro (fees only on
DeFiLlama) and BasedBot (no adapter) are not here.

## Outputs

Prometheus on `:2112/metrics`:

| Gauge | Labels | Meaning |
|---|---|---|
| `trading_app_volume_usd` | app, window=1d/7d/30d | last closed day; 7d and 30d sums, published from 80 % day coverage |
| `trading_app_window_days` | app, window | days with a point inside the window (7 / 30 when complete) |
| `trading_app_volume_chain_usd` | app, chain | last closed day per chain |
| `trading_app_volume_share_pct` | app, window | share of the cohort |
| `trading_app_cohort_volume_usd` | window | cohort total |
| `trading_app_chains` | app | chains with volume on the last day |
| `trading_app_history_days` | app | stored closed days (bench sample size) |
| `trading_app_health` | app | 1 when the last day is within 3 days |
| `trading_app_last_refresh_unix`, `trading_app_fetch_errors_total` | | observability |

JSON on `:2112/v1/history` and mirrored to `HISTORY_FILE_PUBLIC`:

```json
{ "generated_at": "...", "last_closed_day": "2026-09-16", "source": "...",
  "apps": [ { "slug": "gmgn", "name": "GMGN", "llama_slug": "gmgn", "kind": "app",
              "chains": ["BSC", "Solana", ...],
              "days": [ { "day": "2026-09-16", "usd": 103414840,
                          "chains": { "Solana": 13381962, "BSC": 26191954, ... } } ] } ] }
```

On the OCB VPS: container `ocb-trading-app-volume` on `ocb_web`, public
file in `/data/state/aggregate/trading-apps/history.json` (the directory
Caddy already serves as `/aggregate/`), read by the site at
`https://kv.openchainbench.com/aggregate/trading-apps/history.json`
(override with `TRADING_APP_HISTORY_URL`). Prom job `trading-app-volume`.

## Env

| Var | Default | Meaning |
|---|---|---|
| `HISTORY_FILE_PUBLIC` | unset | where to mirror the public JSON |
| `HISTORY_DAYS` | `1500` | closed days kept per app (GMGN's series starts Sep 2023; most adapters only start May–Jun 2026, DeFiLlama did not backfill them) |
| `TICK_MINUTES` | `60` | sweep cadence |
| `METRICS_ADDR` | `:2112` | |
| `DEFILLAMA_BASE` | `https://api.llama.fi` | |

```bash
docker build -t ocb-trading-app-volume .
docker run -d --name ocb-trading-app-volume --network ocb_web --restart unless-stopped \
  -v /data/state/aggregate/trading-apps:/data/public \
  -e HISTORY_FILE_PUBLIC=/data/public/history.json ocb-trading-app-volume
```
