# fiat-onramp-cost · verification checklist

Rule from the spec: never invent an endpoint or parameter. Everything below is either VERIFIED (read from the provider's live documentation or a live keyless call on the date shown) or UNVERIFIED (written from documentation that could not be exercised without a key, or from a search summary). An UNVERIFIED item is not a guess about behaviour, it is a documented shape we could not call.

## Spot references

| Item | Status | Source |
|---|---|---|
| Kraken `GET /0/public/Ticker?pair=XBTEUR,ETHEUR,USDCEUR`, result keys `XXBTZEUR`, `XETHZEUR`, `USDCEUR`, `a`/`b` arrays | VERIFIED live 2026-09-10 (66,437 EUR BTC, 0.02 bps spread) | api.kraken.com |
| Pyth Hermes `GET /v2/updates/price/latest?ids[]=…&parsed=true` | VERIFIED shape; live returns 401 without `PYTH_API_KEY` since 2026-08-26 | hermes.pyth.network |
| Pyth feed ids btc `e62df6c8…`, eth `ff61491a…`, usdc `eaa020c6…`, eurusd `a995d00b…` | VERIFIED 2026-09-10 on `/v2/price_feeds` | hermes.pyth.network |

## MoonPay (direct)

| Item | Status |
|---|---|
| `GET /v3/currencies/{code}/buy_quote?apiKey=pk_…&baseCurrencyCode=eur&baseCurrencyAmount=&paymentMethod=&areFeesIncluded=true` | VERIFIED in docs 2026-09-10 (dev.moonpay.com/reference/getbuyquote) |
| Response fields `quoteCurrencyAmount`, `quoteCurrencyPrice`, `feeAmount`, `extraFeeAmount`, `networkFeeAmount`, `totalAmount`, `expiresIn` | VERIFIED in docs |
| No country parameter; pricing by request IP (`country_source=ip`) | VERIFIED in docs |
| Payment method values `credit_debit_card`, `sepa_bank_transfer` | VERIFIED in widget design guide |
| Currency codes `usdc_base`, `usdc_arbitrum` | UNVERIFIED against live (documented pattern for network-qualified stablecoins; exact codes to confirm on `/v3/currencies` with a key) |
| Live call | UNVERIFIED, no publishable key issued |

## Transak (direct)

| Item | Status |
|---|---|
| `GET /api/v1/pricing/public/quotes` with `x-api-key` header and `partnerApiKey` param | VERIFIED in docs 2026-09-10 |
| Params `fiatCurrency`, `cryptoCurrency`, `network`, `isBuyOrSell=BUY`, `fiatAmount`, `paymentMethod`, `quoteCountryCode` | VERIFIED in docs |
| Response `response.{fiatAmount,cryptoAmount,marketConversionPrice,totalFee,feeBreakdown[]}` | VERIFIED in docs |
| Network value for Bitcoin (`mainnet`) | UNVERIFIED against live |
| `feeBreakdown[].id` values (matched by substring `network` / `partner`, else provider) | UNVERIFIED against live |
| Live call | UNVERIFIED, no partner key |

## Ramp (direct)

| Item | Status |
|---|---|
| `POST /api/host-api/v3/onramp/quote/all?hostApiKey=` with body `cryptoAssetSymbol`, `fiatCurrency`, `fiatValue`, `userCountryCode` | VERIFIED in docs 2026-09-10 |
| Response: `asset{symbol,decimals,price{EUR}}` plus one key per payment method (`CARD_PAYMENT`, `MANUAL_BANK_TRANSFER`, …) each `{cryptoAmount (base units string), fiatValue, appliedFee, baseRampFee}` | VERIFIED in docs |
| Rate limit 100/min, 1000/15 min per IP | VERIFIED in docs |
| Asset symbols `BTC_BTC`, `ETH_ETH`, `BASE_USDC`, `ARBITRUM_USDC` | UNVERIFIED against live (CHAIN_TOKEN convention; confirm on `/api/host-api/v3/assets`) |
| Live call | UNVERIFIED, no host key |

## Mercuryo (direct)

| Item | Status |
|---|---|
| `GET /v1.6/widget/buy/rate?from=EUR&to=&amount=&network=&widget_id=` | VERIFIED in docs 2026-09-10 (path and params) |
| Response shape `{status, data:{amount, rate, fee, fiat_amount}}` | UNVERIFIED against live (documented sample, field set may be wider) |
| No payment-method parameter: only the `card` cell is recorded, `sepa` is `no_quote` | VERIFIED in docs (absence of parameter) |
| Network values `BITCOIN`, `ETHEREUM`, `BASE`, `ARBITRUM` | UNVERIFIED against live |
| Live call | UNVERIFIED, no widget id |

## Onramper (aggregator)

| Item | Status |
|---|---|
| `GET /quotes/{fiat}/{crypto}?amount=&paymentMethod=&country=&type=buy`, `Authorization: pk_prod_…` | VERIFIED in docs 2026-09-10 (page dated 2026-07-28) |
| Response array of `{ramp, paymentMethod, rate, payout, networkFee, transactionFee, quoteId, errors[]}` | VERIFIED in docs |
| Crypto ids `usdc_base`, `usdc_arbitrum` | UNVERIFIED against live (confirm on `/supported/crypto`) |
| Payment method id `sepabanktransfer` | UNVERIFIED against live (`creditcard` is the documented example) |
| Live call | UNVERIFIED, no key |

## Meld (aggregator)

| Item | Status |
|---|---|
| Base hosts `api.meld.io` / `api-sb.meld.io` | VERIFIED in docs |
| Auth `Authorization: BASIC <base64(key:)>` | UNVERIFIED (docs describe BASIC auth with the API key; exact encoding not exercised) |
| Quote path `/payments/crypto/quote` | UNVERIFIED (the reference page returned 404 on 2026-09-10; a search summary names `/payments/virtual-account/quote` for the virtual-account flavour) |
| Params `countryCode`, `sourceCurrencyCode`, `destinationCurrencyCode`, `paymentMethodType`, `sourceAmount` | UNVERIFIED |
| Response `quotes[]{serviceProvider, sourceAmount, destinationAmount, exchangeRate, totalFee, networkFee, transactionFee, partnerFee}` | UNVERIFIED |
| Currency codes `USDC_BASE`, `USDC_ARBITRUM` | UNVERIFIED |
| Live call | UNVERIFIED, no key |

## Excluded from v1 and why

- Coinbase Onramp: the CDP terms reportedly restrict benchmarking (UNVERIFIED verbatim, the terms page returned 403). Not wired until read.
- Apple Pay / Google Pay cells: not quotable server-side without a real wallet session.
- ATM cohort: no public quote API; `ENABLE_ATM_COHORT` is reserved.
- HMAC-signed providers (Banxa, Alchemy Pay direct): reachable only through the aggregators in v1.

## How to flip an item to VERIFIED

Get the key, run `ONCE=1 go run ./cmd/script`, keep the raw response (the harness logs `RawJSONHash`, not the body; capture the body once with `curl`), update the fixture in `cmd/script/testdata/` to the live shape, run `go test ./...`, then edit this file.
