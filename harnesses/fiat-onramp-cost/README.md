# Harness · fiat-onramp-cost

> Produces the `onramp_quote_*` and `spot_reference_*` metrics consumed by [`benchmarks/fiat-onramp-cost.yml`](../../benchmarks/fiat-onramp-cost.yml).

**Bench**: [№ 262 · Fiat on-ramp all-in cost](../../benchmarks/fiat-onramp-cost.yml)

## What it measures

One persona, one region: a retail buyer in France paying in EUR from the eu-west vantage. Every 5 minutes the harness asks each provider for a buy quote on a fixed grid and converts the answer into one number a reader can compare across providers:

```
all_in_premium_bps = (fiat_in / crypto_out − spot) / spot × 10 000
```

`fiat_in` is what the buyer pays, `crypto_out` is what lands in the wallet, `spot` is an exchange mid sampled in the same cycle. The number folds the declared fee, the network fee and whatever spread is hidden in the provider's rate into one figure. The declared fees are recorded separately so the hidden part is visible:

```
declared_fee_bps   = (fee_provider + fee_network + fee_partner) / fiat_in × 10 000
hidden_spread_bps  = all_in_premium_bps − declared_fee_bps
```

Grid: assets `btc/bitcoin`, `usdc/base` (fallback `usdc/arbitrum` when a provider does not list Base), `eth/ethereum`; notionals 100 and 500 EUR; payment methods card and SEPA. 12 cells per provider per cycle.

Two cohorts, never ranked against each other:

- `onramp`: MoonPay, Transak, Ramp, Mercuryo, quoted directly through their own API.
- `aggregator`: Onramper and Meld. One request returns one quote per member ramp; each becomes a sample labelled `provider=<member> via=<aggregator>`.

## Spot references

- `kraken_eur` (headline): Kraken public Ticker, EUR pairs, mid of best bid and ask. Keyless.
- `pyth`: Pyth Hermes `BTC/USD`, `ETH/USD`, `USDC/USD` divided by `EUR/USD`. Needs `PYTH_API_KEY` since 2026-08-26. Cross-check only.

`spot_reference_divergence_bps{asset}` records the gap between the two so a reader can judge how much the reference choice moves the result.

## Metrics

```
onramp_quote_all_in_premium_bps{provider,cohort,via,asset,network,payment_method,notional,fiat,country,region,country_source,spot_ref}  gauge
onramp_quote_declared_fee_bps{…same minus spot_ref}                gauge
onramp_quote_hidden_spread_bps{…with spot_ref}                     gauge
onramp_quote_crypto_out{…}                                         gauge
onramp_quote_ttl_seconds{…}                                        gauge (0 when the provider returns none)
onramp_quote_success{…}                                            gauge 1/0 per cell
onramp_quote_latency_ms{provider}                                  histogram
onramp_quote_errors_total{provider,reason}                         counter (no_quote, http_4xx, http_5xx, rate_limited, timeout, network, parse)
onramp_quote_samples_total{…}                                      counter, one per usable quote (use increase() for sample counts)
onramp_limits_min_fiat / onramp_limits_max_fiat{provider,payment_method,asset}  gauge
spot_reference_price{asset,fiat,source}                            gauge
spot_reference_divergence_bps{asset,fiat}                          gauge
onramp_last_cycle_timestamp_seconds                                gauge
```

`country_source` is `param` when the provider's API takes a country code (Transak, Ramp, Onramper, Meld) and `ip` when it geolocates the request (MoonPay, Mercuryo). The harness runs from an EU vantage so both resolve to France, but the reader should know which.

A cell that stops answering is purged, not frozen: the gauges are deleted and `onramp_quote_success` goes to 0. Same rule as bench 001.

## Reproduce in five steps

1. `cp .env.example .env` and fill the keys you have. Any provider without a key is skipped.
2. `go test ./...` runs the maths, the spot parsers and every adapter against the fixtures in `cmd/script/testdata/`.
3. `set -a && source .env && set +a && go run ./cmd/script` starts the loop. `ONCE=1` runs one cycle and exits.
4. `curl localhost:2113/metrics` shows the gauges; `curl localhost:2113/config` shows the resolved grid with keys redacted.
5. `OCB_LIVE=1 go test -run TestLiveSpotReferencesAgree ./cmd/script` checks the two spot references against each other over the network.

Port: `:2113`. Endpoints: `/metrics`, `/healthz`, `/config`.

## Rate limits and budget

Ramp documents 100 requests/min and 1000/15 min per source IP. One cycle is at most 12 requests per provider, spaced by a per-provider semaphore of 2 in flight, so a 5 minute cycle stays two orders of magnitude under that. Each cycle's start is jittered by ±10 % so no provider sees a fixed pattern from one IP. A 4xx is never retried; a 5xx or timeout is retried once.

## What is not verified against live

See [CHECKLIST.md](./CHECKLIST.md). The harness never invents a response: each adapter is written against the provider's documented schema and the fixtures mirror that documentation, but until a key is issued the exact currency codes and a few response fields carry an UNVERIFIED flag.

## Hosting

Container `ocb-fiat-onramp-cost` on the Paris VPS (eu-west), same Docker network as the shared Prometheus, scraped as job `fiat-onramp-cost` (see [`infrastructure/prometheus/prometheus.yml`](../../infrastructure/prometheus/prometheus.yml)). Provider keys live in the VPS env file for the container and nowhere in git. `railway.toml` is kept so the same image runs on Railway if a second region is ever added.
