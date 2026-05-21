# buyback-audit methodology

Companion document to [`buyback-audit.yml`](./buyback-audit.yml). Mirrors the harness README in the [mobula-monorepo `miniapps/buyback-audit/`](https://github.com/MobulaFi/mobula-monorepo/tree/main/miniapps/buyback-audit) folder so both repos stay in sync.

Bench № 018 - measures `executed_USD / promised_USD` for live on-chain token buyback programs over rolling 7-day and 30-day windows. No transactions are sent. The harness polls DeFiLlama for the promised side, and the destination wallet's actual token inflows (via the Hyperliquid `info` API for HYPE and Etherscan v2 for SKY) for the executed side, then publishes both as Prometheus gauges along with the ratio.

## Why this bench is honest

Every protocol with a buyback program publishes a fee share ("97% of fees buy back HYPE", "100% of surplus buys SKY"). Those numbers are commitments, not measurements. This bench takes the commitment as input and asks: given the protocol's own reported fees over the last 7 / 30 days, how much of the implied USD value actually arrived at the destination wallet. The ratio is the answer; the two windows surface execution cadence vs sustained delivery.

## Coverage in v1

| Protocol | Destination | Promise | Promised source | Executed source |
| --- | --- | --- | --- | --- |
| **Hyperliquid** | Assistance Fund `0xfefe…fefe` | 97% of HyperCore fees | DeFiLlama `hyperliquid` | Hyperliquid `info` API user fills, priced at `metaAndAssetCtxs` on-chain oracle |
| **Sky / Maker** | SBE receiver `0xBE8E…98FB` | 100% of protocol surplus | DeFiLlama `makerdao` | Etherscan v2 (`chainid=1`) SKY ERC-20 inflows, priced at CoinGecko `sky` |

## Excluded in v1

| Protocol | Why |
| --- | --- |
| **GMX** | V2 does not run a single on-market buyback wallet. Fees flow to GLP / GM pool LPs in ETH and stables, and to GMX stakers via esGMX reward distributors. The original treasury `0x68863dDE…dea6A` has been dormant since 2022-08 (verified via Etherscan v2). An audit of `executed_usd / promised_usd` shape has nothing to point at, so reporting a number would be dishonest. |

v2 will add Jupiter Litterbox Trust (50% of Jupiter fees → on-market JUP buyback on Solana) and Aave AFC once their executor addresses are confirmed.

## Honest reading of a low ratio

A ratio well below 1.0 is not automatically under-delivery. Two regimes produce it:

1. **Batched execution.** Sky's SBE accumulates surplus inside the Maker / Sky protocol and concentrates on-market SKY buys into irregular batches via Uniswap. A 7-day window taken mid-accumulation reads low; the long-run accrual to the destination address tracks closer to 1.0.
2. **Sustained under-funding.** The promised share overstates what is actually being routed to the buyback program. This shows up as a 30-day ratio that stays well below 1.0 across multiple snapshots — the cadence signal in (1) damps out, the structural signal does not.

The 7d vs 30d split is the cheapest tell for which regime is in play. Continuous executors (Hyperliquid AF) show 7d ≈ 30d; batched executors (Sky SBE) show 7d < 30d; structurally under-funded programs would show both windows low.

## Operational requirement

The Sky leg requires `ETHERSCAN_API_KEY` set on the harness host. Without it, the executed-side query returns 0 and the Sky ratio reads 0 regardless of what SBE actually did on-chain. The Etherscan v2 single-key unified endpoint (5 req/s, 100k req/day on the free tier) is more than enough for the one paginated call per protocol per 5-minute scrape. The Hyperliquid leg has no upstream key requirement.

## Metrics emitted

```
ocb_buyback_executed_usd{protocol, window}              gauge (USD)
ocb_buyback_promised_usd{protocol, window}              gauge (USD)
ocb_buyback_ratio{protocol, window}                     gauge (executed / promised, 0..1+)
ocb_buyback_scrape_errors_total{protocol, source}       counter
ocb_buyback_last_scrape_timestamp_seconds{protocol}     gauge
```

`window` is `7d` or `30d`. `protocol` is `hyperliquid` or `sky`. The leaderboard YAML consumes the 7d window by default; readers comparing cadence vs sustained delivery can query the 30d series directly against the same metric.

## Source

Harness lives in the (private) [mobula-monorepo](https://github.com/MobulaFi/mobula-monorepo) under `miniapps/buyback-audit/`. Spec + this doc live here in the public OpenChainBench repo. Both stay in sync via PR.
