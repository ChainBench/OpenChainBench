# rwa-yield-accuracy

OpenChainBench harness for bench №089 — measures on-chain delivered
yield vs advertised APY for a cohort of top tokenized U.S. Treasuries
and money-market funds.

## What it measures

For each token in the cohort:

- **Delivered yield** derived from the issuer's own on-chain
  distribution mechanism:
    - Rebase (USDY): `totalSupply(t=now) vs totalSupply(t=window ago)`
    - Dividend (BUIDL, USTB): sum of USDC `Transfer` events from
      treasury to holders over the window
    - NAV appreciation (BENJI, OUSG): NAV(now) vs NAV(window ago),
      fetched from the issuer's public API and cross-checked with the
      on-chain oracle where one exists
- **Promised APY** from `promised-yields.yml` (curated weekly).
- **Deviation in basis points**: delivered minus promised, sign
  preserved.

Windows: 30d headline, 7d volatility, lifetime for cross-issuer
comparison unaffected by short-window distribution cycles.

## Cohort

| Token | Issuer          | Chain(s)                | Model                |
|-------|-----------------|-------------------------|----------------------|
| BUIDL | BlackRock       | Ethereum + 5 L2s (V1: ETH only) | Monthly USDC dividend |
| BENJI | Franklin        | Stellar + Ethereum      | NAV appreciation     |
| USDY  | Ondo            | Ethereum + Solana + Aptos + Sui (V1: ETH only) | Daily rebase |
| USTB  | Superstate      | Ethereum                | Monthly USDC dividend |
| OUSG  | Ondo            | Ethereum                | NAV appreciation     |

V2 will add non-Ethereum chains.

## Metrics exposed (Prometheus, port 2112 `/metrics`)

```
rwa_yield_promised_bps{issuer, token, chain}
rwa_yield_delivered_bps_30d{issuer, token, chain}
rwa_yield_delivered_bps_7d{issuer, token, chain}
rwa_yield_delivered_bps_lifetime{issuer, token, chain}
rwa_yield_deviation_bps_30d{issuer, token, chain}
rwa_yield_deviation_bps_7d{issuer, token, chain}
rwa_yield_total_supply_units{issuer, token, chain}
rwa_yield_aum_usd{issuer, token, chain}
rwa_yield_probe_ok{issuer, token, chain}
rwa_yield_last_measured_unix{issuer, token, chain}
rwa_yield_probe_errors_total{issuer, token, chain, error_type}
rwa_yield_distributions_usd_total{issuer, token, chain}
```

## Cadence

- On-chain reads: every 60 seconds.
- Rolling-window delivered yield: recomputed hourly (heavy, values
  move slowly).
- `promised-yields.yml`: reloaded every 60 seconds so a weekly edit
  lands within one scrape cycle.

## Configuration

Environment variables:

```
LISTEN_ADDR              default :2112
RPC_ETHEREUM             required. HTTP endpoint for Ethereum mainnet.
                         BUIDL, USDY, USTB, OUSG read here.
LOGS_TOKEN               optional. Enables GET /logs?tail=N
                         with X-Logs-Token header.
```

BENJI, USDY multi-chain support come in V2.

## Reproducibility

Every delivered-yield number derives from a public RPC call
(contract address, event signature, block range documented in the
per-issuer file). Every promised-yield number cites the URL and date
in `promised-yields.yml`. Point this harness at the same endpoints
and you reproduce every number on the bench page.
