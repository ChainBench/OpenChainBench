# buyback-audit (OCB #018)

OpenChainBench harness that measures `executed_USD / promised_USD` for
the on-chain buyback programs of three large DeFi protocols over rolling
7-day and 30-day windows.

## Protocols

| Protocol     | Treasury / spender                                | Promise (fee share) | Source                              |
|--------------|---------------------------------------------------|---------------------|-------------------------------------|
| Hyperliquid  | Assistance Fund `0xfefe…fefe`                     | 97 %                | Hyperliquid `info` API + DeFiLlama  |
| Sky / Maker  | SBE receiver `0xBE8E…98FB`                        | 100 % (SBE)         | Etherscan v2 (chainid=1) + DL       |

GMX was dropped from v1 — V2 does not run a single auditable on-market
buyback wallet, fees flow to GLP/GM pool LPs in stables/ETH and to GMX
stakers via esGMX reward distributors. v2 of this bench will add
Jupiter Litterbox Trust (50 % fees → JUP buyback) and Aave AFC.

Prices: CoinGecko free tier (`hyperliquid`, `gmx`, `maker`, `ethereum`).
For Hyperliquid we prefer the on-chain oracle price returned by
`metaAndAssetCtxs` because that is the price the AF actually pays.

## Metrics (`:2112/metrics`)

```
ocb_buyback_executed_usd{protocol,window}              gauge
ocb_buyback_promised_usd{protocol,window}              gauge
ocb_buyback_ratio{protocol,window}                     gauge — executed / promised
ocb_buyback_scrape_errors_total{protocol,source}       counter
ocb_buyback_last_scrape_timestamp_seconds{protocol}    gauge
```

Windows: `7d`, `30d`. Scrape cadence: 5 min per protocol.

## Env

### `ETHERSCAN_API_KEY` — **required** for GMX & Sky

Without the key, only Hyperliquid emits real `executed_usd` values.
GMX and Sky `executed_usd` stay at **0** (and only their `promised_usd`
is meaningful), so 2/3 of the bench is non-functional.

**How to set it (free, 3 minutes):**

1. Create an account at https://etherscan.io
2. Go to https://etherscan.io/apidashboard → **Add** → name it
   (e.g. `ocb-buyback-audit`).
3. The same key works across Ethereum, Arbitrum, Base, Optimism,
   Polygon, BSC via the Etherscan V2 unified endpoint
   (`api.etherscan.io/v2/api?chainid=…`). Limits on the free tier:
   **5 req/s, 100k req/day** — well above what this bench needs
   (one paginated call per protocol per 5-minute scrape).
4. On Railway → service `buyback-audit` → Variables → add:
   ```
   ETHERSCAN_API_KEY=<your_key>
   ```
5. Redeploy. The startup log line changes from
   `[warn] ETHERSCAN_API_KEY not set` to
   `[gmx][7d] executed=$… ratio=…`.

The key never enters this repo — it lives only as a Railway env var.

## Run locally

```
cd miniapps/buyback-audit
go mod tidy
go run ./cmd/script
# in another shell
curl -s localhost:2112/metrics | grep ocb_buyback
curl -s localhost:2112/health
```

## Deploy (Railway)

`railway.toml` pins healthcheck to `/health`. The container exposes
`:2112`; do **not** rely on `$PORT` — the shared Prometheus scrapes the
internal DNS `<service>.railway.internal:2112` directly.
