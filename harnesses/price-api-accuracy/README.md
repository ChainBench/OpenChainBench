# price-api-accuracy (OpenChainBench bench 305)

How far the USD price a crypto market-data API publishes sits from the
exchange price of the same moment, on nine majors: BTC, ETH, SOL, BNB, XRP,
ADA, DOGE, AVAX, LINK.

## Reference

Median of three exchange mids, refreshed every 5 s:

| Venue    | Endpoint                                   | Quote |
| -------- | ------------------------------------------ | ----- |
| Coinbase | `GET /products/<A>-USD/ticker` (bid, ask)  | USD   |
| Kraken   | `GET /0/public/Ticker` (bid, ask)          | USD   |
| Binance  | `GET /api/v3/ticker/bookTicker`            | USDT, converted at Kraken's USDT/USD mid |

An asset enters a snapshot only when two venues priced it. A provider's
answer is scored against the snapshot nearest the moment it arrived, within
6 s; otherwise the poll is counted as `no_reference` and never against the
provider.

Binance is converted rather than read as USD because USDT traded at 0.9988
on 2026-10-19, which put every USDT book about 12 bps above the USD ones.

## Providers

| Slug        | Endpoint                                          | Auth            | Poll   | Ranked |
| ----------- | ------------------------------------------------- | --------------- | ------ | ------ |
| bitculator  | `GET /api/v1/prices?slugs=` (batch)               | Bearer key      | 5 min  | yes |
| coingecko   | `GET /api/v3/simple/price` (batch)                | none, via proxy | 60 s   | yes |
| coinpaprika | `GET /v1/tickers/<id>` (nine calls)               | none            | 20 min | yes |
| coinstats   | `GET /coins?limit=100`                            | `X-API-KEY`     | 2 min  | yes |
| mobula      | `GET /api/1/market/multi-data?ids=` (batch)       | `Authorization` | 30 s   | yes |
| codex       | GraphQL `getTokenPrices`                          | `Authorization` | 60 s   | no, on-chain |
| serialized  | `POST /v1/token/price` (batch)                    | `Authorization` | 60 s   | no, on-chain |

Poll cadences follow each provider's quota: Bitculator's assigned key allows
10,000 requests a month, CoinPaprika's keyless tier 25,000 a month and 60 an
hour. Polling less often gives fewer samples of the same distribution, not a
different score.

CoinGecko's keyless API answers 429 to the VPS's shared address, so it is
reached through a proxy. That is why the bench publishes no latency.

Mobula is addressed by numeric asset id. By name, "Bitcoin" resolved to a
different token priced at 9e-14 USD in 3 of 66 internal polls.

Codex and Serialized price the wrapped token in its DEX pools (WETH, wSOL,
WBNB, LINK, WAVAX), not the coin's market. They are listed unranked. BTC is
left out for them: WBTC trades 15 to 20 bps under BTC, so scoring it against
BTC would charge the provider for the wrapper's discount. Serialized does not
index Avalanche.

## Metrics

```
price_api_deviation_bps{provider, asset}            histogram, |gap| in bps
price_api_signed_deviation_bps{provider, asset}     gauge, last signed gap
price_api_price_usd{provider, asset}                gauge
price_api_price_age_seconds{provider, asset}        gauge, from the provider's own stamp
price_api_requests_total{provider, status}          counter
price_api_asset_polls_total{provider, asset, status} counter: ok, missing, failed, no_reference
price_api_reference_mid_usd{asset}                  gauge
price_api_reference_sources{asset}                  gauge
price_api_usdt_usd                                  gauge
price_api_poll_interval_seconds{provider}           gauge
```

`asset` is lowercase. The recording rules in
`infrastructure/monitoring/prometheus/recording_rules/ocb_price_api_accuracy.yml`
copy it to `kind`, the dimension key the site filters on.

Port `:2112`. Runs on the OCB VPS as `ocb-price-api-accuracy` on the
`ocb_web` network.

## Run locally

```bash
cp .env.example .env   # fill the keys you have
set -a; . ./.env; set +a
go run ./cmd/script
curl -s localhost:2112/metrics | grep price_api_
```
