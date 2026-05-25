# validator-yield

OpenChainBench bench №026 — **Validator Net Yield Comparison**.

Ranks validators by net yield = `gross APR × uptime` (slashing treated
as negligible in v1, MEV included in `gross APR` where the upstream
already folds it in — see "Honest scope" below).

Scope v1: **Solana** + **Hyperliquid** (Ethereum deferred to v2).

## Honest scope (no marketing)

The bench reports **net yield**, not "yield net of MEV". For Solana,
Stakewiz's `total_apy` already aggregates staking rewards + Jito MEV
into a single APR. For Hyperliquid, there is no separate MEV layer
(centralised sequencer). So `ocb_validator_mev_share_bps` is exposed
for transparency on the MEV-vs-stake split, but it is **not** subtracted
from the gross figure. The number compared across validators is total
APR × uptime, not "yield after MEV is removed".

## Sources (all free, no API key)

| Chain | Source | Endpoint |
|-------|--------|----------|
| Solana | Stakewiz | `GET https://api.stakewiz.com/validators` |
| Solana (enrichment) | Jito Kobe | `GET https://kobe.mainnet.jito.network/api/v1/validators` |
| Hyperliquid | Hyperliquid `/info` | `POST https://api.hyperliquid.xyz/info` body `{"type":"validatorSummaries"}` |
| Prices (SOL) | CoinGecko | `GET https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd` |
| Prices (HYPE) | Hyperliquid `/info` | `POST` body `{"type":"metaAndAssetCtxs"}` |

## Cap

Solana exposes ~3000 validators; we cap **top 200 by activated stake**
to keep Prometheus cardinality reasonable. Hyperliquid exposes all
(~30).

## Metrics (port 2112, OCB convention)

```
ocb_validator_net_yield_bps{chain, validator, name}
ocb_validator_gross_yield_bps{chain, validator, name}
ocb_validator_mev_share_bps{chain, validator, name}
ocb_validator_commission_bps{chain, validator, name}
ocb_validator_uptime_pct{chain, validator, name}
ocb_validator_stake_usd{chain, validator, name}
ocb_validator_jailed{chain, validator, name}
ocb_chain_median_net_yield_bps{chain}
ocb_chain_total_validators{chain}
ocb_validator_scrape_errors_total{chain, source}
ocb_validator_last_scrape_timestamp_seconds{chain}
```

## Run locally

```bash
go mod tidy
go build ./cmd/script
./script
curl localhost:2112/metrics
```

## Deploy (Railway)

Hardcoded `:2112`. The shared OCB Prometheus scrapes the internal DNS
`<service>.railway.internal:2112`. Do **not** rely on `$PORT`.
