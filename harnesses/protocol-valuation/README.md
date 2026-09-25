# protocol-valuation

Hourly valuation snapshot for every DeFi token whose protocol earns fees. Feeds bench **274 `protocol-pf-ratio`**: market cap / annualized fees, read against the token's own category median, with FDV/F, float, the monthly fee trend, and since 2026-09-25 revenue, P/S, TVL and realized dilution.

It is the market-wide cousin of `perp-token-metrics` (benches 234 and 265). That harness carries a registry of twenty perp DEXes written by hand; this one joins DeFiLlama's fee adapters to their tokens through DeFiLlama's own parent table and resolves about 190 tokens, of which about 180 clear the floors (the bench page shows an editorial cut of them).

## Inputs

| Source | Endpoint | What we take |
|---|---|---|
| DeFiLlama | `GET /overview/fees` | one row per fee adapter: `total30d`, `total60dto30d`, `total1y`, `defillamaId`, `parentProtocol`, `category` |
| DeFiLlama | `GET /overview/fees?dataType=dailyRevenue` | same rows, revenue. Joined to the fee adapters by `defillamaId` |
| DeFiLlama | `GET /protocols` | child protocols: `gecko_id`, `parentProtocol`, `tvl` |
| DeFiLlama | `GET /config` | the parent protocols and their `gecko_id`, which is what turns 90 resolved tokens into 190 |
| CoinGecko | `GET /coins/markets?ids=...` | `market_cap`, `fully_diluted_valuation`, `circulating_supply`, `total_supply`, 30d price change. One page per 250 ids |
| CoinGecko | `GET /coins/{id}/market_chart?days=91&interval=daily` | daily `prices` and `market_caps`; their ratio is the circulating supply CoinGecko held that day. One call per token per UTC day |

A fee adapter is per product (Uniswap V2, V3, V4; GMX's five products) and the token belongs to the parent. Adapters resolving to one token are summed into one row: ranking them apart would divide one market cap by a fraction of its own revenue several times. Revenue follows the same adapters. TVL is summed over every `/protocols` row that resolves to the token by the same rule (own `gecko_id` first, else the parent's), fee adapter or not, so Aave V2, V3 and Horizon count once each under AAVE.

## Formulas

```
annual(x)   = x_30d * 365 / 30
P/F         = mcap / annual(fees)
FDV/F       = fdv  / annual(fees)
P/S         = mcap / annual(revenue)
float %     = 100 * circulating / total supply
fees MoM %  = 100 * (fees_30d / fees_prev_30d - 1)
supply Δ %  = 100 * (circ_now / circ_then - 1),  circ_day = mcap_day / price_day
vs category = P/F / median P/F of the category (5 tokens or more)
diverging   = fees MoM > 0 and price 30d < 0 and P/F < category median
```

Absent, never zero: a ratio whose denominator is missing or zero is not published. No revenue series means "unknown", not "keeps nothing", so P/S stays absent. No `/protocols` row with a TVL means nothing locked, so TVL stays absent. A supply series shorter than the window (a token listed six weeks ago) has no 90-day figure.

Supply change is realized dilution, what reached the float over the window, not an unlock schedule. A cliff next month is invisible until it lands.

## Floors and flags

- Fee floor: 100,000 USD of trailing 30d fees, applied to the token after its adapters are summed.
- Float floor: 10 % of total supply circulating. Below it P/F reads near zero and would lead an ascending board.
- `protocol_fees_incomplete`: an adapter reports nothing over 30 days after more than 1M USD over the year, so the fee total is knowably short. The row keeps its gauges but leaves the ranking and the category median. `protocol_revenue_incomplete` is the same rule on the revenue series, and is set whenever the fee flag is.
- Category: the one carrying most of the token's fees, not the first adapter's.

## Metrics

Per-protocol gauges carry `protocol="<slug>"`; the ones a dashboard groups on also carry `category`.

```
protocol_pf_ratio                 protocol_fees_30d_usd{category}       protocol_mcap_usd
protocol_pf_fdv_ratio             protocol_fees_prev_30d_usd            protocol_fdv_usd
protocol_ps_ratio{category}       protocol_annual_fees_usd              protocol_float_pct
protocol_pf_vs_category_ratio     protocol_fee_growth_30d_pct           protocol_price_change_30d_pct
protocol_diverging                protocol_revenue_30d_usd{category}    protocol_supply_change_30d_pct{category}
protocol_fees_incomplete          protocol_annual_revenue_usd           protocol_supply_change_90d_pct{category}
protocol_revenue_incomplete       protocol_silent_adapter_fees_1y_usd   protocol_tvl_usd{category}
protocol_info{name,category}      protocol_valuation_health

protocol_category_pf_median{category}   protocol_category_size{category}

protocol_valuation_cohort_size          protocol_valuation_adapters_total
protocol_valuation_unmapped_adapters    protocol_valuation_via_parent
protocol_valuation_merged_adapters      protocol_valuation_peer_groups
protocol_valuation_last_success_unix    protocol_valuation_fetch_errors_total{source}
protocol_valuation_coingecko_calls_total  protocol_valuation_coingecko_429_total
protocol_valuation_supply_cache_size    protocol_valuation_coingecko_gap_seconds
```

Every per-protocol vector is reset each poll: the cohort is rebuilt from upstream, so a token that is delisted or drops below a floor loses its row rather than carrying a stale valuation forward.

## Budget

Four DeFiLlama reads and one CoinGecko `/coins/markets` page per hour. The supply series is one CoinGecko `/market_chart` call per row per UTC day (about 180), cached in memory and rebuilt once after a restart; the poll publishes the board first and republishes with the dilution columns once the series are in. The public tier, no key, allows somewhere between 5 and 30 calls a minute per address and the address is shared with the other harnesses on the host, so the pacer starts 6 s apart, doubles the gap on a 429 (up to 60 s) and halves it back after 20 clean calls. A 429 backs off for `Retry-After` or 65 s and is retried three times; after one token exhausts its retries the tick stops fetching and leaves the rest to the next hour, so a throttled day fills the cohort over several ticks. `protocol_valuation_coingecko_calls_total`, `_429_total` and `_gap_seconds` are the series to check the claim against.

## Run

```
go test ./... && go vet ./...
go run ./cmd/script                    # /metrics on :2112, first poll immediately
curl -s localhost:2112/metrics | grep -E 'protocol_(ps_ratio|tvl_usd|supply_change)'
```

Environment: `REFRESH_MINUTES` (60), `MIN_FEES_30D_USD` (100000), `MIN_FLOAT_PCT` (10), `METRICS_ADDR` (:2112). `COINGECKO_API_KEY` is optional: a free demo key (30 calls a minute, 10k a month) is sent as `x-cg-demo-api-key` and lifts the address-shared public limit; without it the harness runs the same, only slower on the supply pass.
