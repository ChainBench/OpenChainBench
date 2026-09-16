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
| Currency codes `usdc_base`, `usdc_arbitrum` | UNVERIFIED on live: with a `pk_test_` key the API answers `Currency not supported in test mode` (test-mode restriction, not a code error). `btc`, `eth`, `usdc` VERIFIED live 2026-09-14 |
| Live call | VERIFIED 2026-09-14 with a `pk_test_` key: `quoteCurrencyAmount`, `quoteCurrencyPrice`, `feeAmount` (3.99 minimum), `extraFeeAmount`, `networkFeeAmount`, `totalAmount` all present for card and sepa; test-mode prices track Kraken mid within ~4 % (MoonPay spread) |

## Transak (direct)

| Item | Status |
|---|---|
| `GET /api/v1/pricing/public/quotes` with `x-api-key` header and `partnerApiKey` param | VERIFIED in docs 2026-09-10 |
| Params `fiatCurrency`, `cryptoCurrency`, `network`, `isBuyOrSell=BUY`, `fiatAmount`, `paymentMethod`, `quoteCountryCode` | VERIFIED in docs |
| Response `response.{fiatAmount,cryptoAmount,marketConversionPrice,totalFee,feeBreakdown[]}` | VERIFIED in docs |
| Network value for Bitcoin (`mainnet`) | VERIFIED live 2026-09-14 (also `ethereum`, `base`, `arbitrum`) |
| `feeBreakdown[].id` values | VERIFIED live 2026-09-14: `transak_fee`, `network_fee` (substring match holds). `marketConversionPrice` is crypto per EUR (inverted in the adapter) |
| Live call | VERIFIED 2026-09-14 on `api.transak.com` (production key). EUR payment methods on this account: card, Apple Pay, Google Pay; `sepa_bank_transfer` answers 400 "Invalid payment method" and is recorded as no_quote until bank transfers are enabled (KYB) |

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
| Response shape | VERIFIED live 2026-09-14: `{status, data:{amount, rate, fee:{BTC,EUR}, mercuryo_fee:{..}, network_fee:{..}, partner_fee:null, fiat_amount, subtotal:{..}, total:{..}, kyc_limits, ...}}`. Money fields are `{crypto, fiat}` pairs, not scalars; parser rewritten, `testdata/mercuryo_rate.json` is a real response |
| No payment-method parameter: only the `card` cell is recorded, `sepa` is `no_quote` | VERIFIED in docs (absence of parameter) |
| Network values `BITCOIN`, `ETHEREUM`, `BASE`, `ARBITRUM` | VERIFIED live 2026-09-14, all four quote |
| Live call | VERIFIED 2026-09-14 using the public `widget_id` Mercuryo embeds on its own homepage; an OCB-issued id from dashboard.mercuryo.io is still to be requested |

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
| Base hosts `api.meld.io` / `api-sb.meld.io` | VERIFIED live 2026-09-16 (sandbox key: 200 on `api-sb`, 403 on `api`) |
| Auth `Authorization: BASIC base64(<key>)` | VERIFIED live 2026-09-16. The dashboard key is already `<id>:<secret>`; `base64(key + ":")` gives 403. Adapter fixed. |
| Method / path `POST /payments/crypto/quote` (JSON body) | VERIFIED live 2026-09-16. GET gives 405 METHOD_NOT_ALLOWED. Adapter fixed (was GET with query params). |
| Header `Meld-Version: 2025-03-04` | VERIFIED live (accepted; sent to pin the shape) |
| Body `countryCode`, `sourceCurrencyCode`, `sourceAmount` (number), `destinationCurrencyCode`, `paymentMethodType` | VERIFIED live |
| Response `quotes[]{serviceProvider, sourceAmount, destinationAmount, exchangeRate, totalFee, networkFee, transactionFee, partnerFee (null), paymentMethodType, customerScore, ...}` | VERIFIED live; `partnerFee` is null, parsed as pointer. `testdata` not stored: sandbox numbers are synthetic. |
| Currency codes `BTC`, `ETH`, `USDC_BASE` | VERIFIED live (sandbox lists BANXA only) |
| Errors | VERIFIED: 400 `INVALID_AMOUNT_TOO_HIGH` ("maximum allowed 95.00 EUR for BANXA" on SEPA in sandbox), 408 `QUOTE_TIMEOUT` when a member is slow. 400/404 map to `ErrNoQuote`. |
| Full harness cycle | VERIFIED 2026-09-16 with `MELD_SANDBOX=true`: 6 quotes, labels `via="meld"`, `provider="banxa"`, `cohort="aggregator"`. |
| Sandbox pricing | NOT USABLE for published numbers: BTC quoted at 90,274 EUR vs 65,676 Kraken mid (+3,749 bps), ETH +3,981 bps. Production key required before Meld enters the bench. |
| Production key | PENDING (asked Meld on 2026-09-15; the key received on 2026-09-16 is sandbox-scoped) |

## Excluded from v1 and why

- Coinbase Onramp: the CDP terms reportedly restrict benchmarking (UNVERIFIED verbatim, the terms page returned 403). Not wired until read.
- Apple Pay / Google Pay cells: not quotable server-side without a real wallet session.
- ATM cohort: no public quote API; `ENABLE_ATM_COHORT` is reserved.
- HMAC-signed providers (Banxa, Alchemy Pay direct): reachable only through the aggregators in v1.

## How to flip an item to VERIFIED

Get the key, run `ONCE=1 go run ./cmd/script`, keep the raw response (the harness logs `RawJSONHash`, not the body; capture the body once with `curl`), update the fixture in `cmd/script/testdata/` to the live shape, run `go test ./...`, then edit this file.
