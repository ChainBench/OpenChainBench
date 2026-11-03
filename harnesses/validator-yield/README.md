# validator-yield

OpenChainBench bench №026, **Highest staking yield**.

Ranks PoS chains by the median net yield a staker keeps on the chain's
validators (or pools, or the one synthetic profile where the chain has
no per-validator figure). Unit: basis points of APR (1% = 100 bps).
Net means after the operator's commission and, where the chain exposes
it, after downtime. Simple APR, no compounding.

## What is compared, chain by chain

| Chain | Cohort | Gross | Net | Source (keyless) |
|---|---|---|---|---|
| Solana | top 200 by stake | Stakewiz `total_apy` (inflation + Jito MEV, already net of commission) | gross × uptime | `api.stakewiz.com/validators`, Jito Kobe |
| Hyperliquid | all active | `predictedApr.day` | gross × uptime | `api.hyperliquid.xyz/info` |
| Ethereum | 1 synthetic row | consensus spec APR on live effective balance, MEV excluded | = gross | ultrasound.money |
| Cardano | top 50 pools by stake | measured: last epoch's paid rewards × 73 / active stake | gross × (1 − margin) | Koios `epoch_info`, `pool_list` |
| Sui | all active | measured: 30-epoch growth of each pool's exchange rate (net of commission) | as measured | Sui GraphQL |
| Cosmos Hub | top 200 bonded | annual issuance × (1 − community tax) / bonded | gross × (1 − commission) | PublicNode LCD |
| Avalanche | top 100 P-Chain | each validator's `potentialReward` / stake, annualized over its period | gross × uptime × (1 − delegation fee) | `api.avax.network` P-Chain |
| Aptos | active delegation pools | `rewards_rate` per epoch × epochs/year (2.6% after the 2026 cut) | gross × proposal success × (1 − operator commission) | Aptos Labs REST |
| NEAR | top 200 by stake that are staking pools | supply × max inflation × (1 − treasury share) / total stake | gross × online factor × (1 − pool fee) | FastNEAR free RPC |
| Kaia | council nodes with public delegation | per-block `stakers` reward × blocks/year / staked | gross × (1 − PD commission) | `public-en.node.kaia.io` |
| Algorand | 1 synthetic row (incentive-eligible node) | blocks/year × mean proposer payout / online stake | = gross | Nodely algod |
| ICP | 1 synthetic row (NNS neuron, 2 y dissolve delay, no age bonus) | 365.25 × daily voting reward pool × 3 / deciding voting power | = gross | ic-api.internetcomputer.org |
| Gram (TON) | verified nominator pools | TonAPI pool APY, de-compounded to APR | = gross (pool fee already netted) | tonapi.io |
| Sei | all bonded | seichain release schedule annualized / bonded | gross × (1 − commission) | PublicNode LCD |
| Cronos (POS) | all bonded | annual issuance × (1 − community tax) / bonded | gross × (1 − commission) | crypto.org LCD |

"Annual issuance" on x/mint chains (Hub, Cronos) is
`annual_provisions × real blocks per year / blocks_per_year param`:
the module mints `annual_provisions / blocks_per_year` per block
(checked against supply growth on 2026-11-03: 12.38 ATOM per block),
so faster real blocks mean more issuance. On the Hub (5.7 s blocks
against a 7.2 s param) that puts the gross at ~19.6%, above the ~15.5%
that explorers quote from the uncorrected formula.

Each scraper file opens with the reward rule it implements, the
verification run (date, inputs, result) and the sanity figure it was
checked against.

## Excluded, and why

| Chain | Reason |
|---|---|
| Stellar | No staking: Stellar consensus (SCP) pays validators nothing and XLM has no delegation or inflation (the inflation mechanism was removed in protocol 12, 2019). There is no staking yield to measure. |
| Somnia | Rewards are 50% of gas fees only (no issuance), paid into the staking contract by the protocol at each ~5 min epoch through `updateRewardsFromEpoch()`, which emits no event (zero logs from the staking contract over 8000 blocks, 2026-11-03), and `eth_getLogs` is capped at 1000 blocks (100 s). The contract's balance moves with stakes, unstakes and claims too, so the fee inflow cannot be isolated keylessly. Third parties read the trailing figure from Somnia's own dashboard rather than on-chain; published estimates range from 0.06% to 0.25%. Not published rather than guessed. |
| Cronos EVM | Validators are permissioned (PoA); CRO is staked on the Cronos POS chain, which is what the `cronos` row measures. |

## Honest scope

- MEV: included where the upstream folds it in (Solana), absent where
  the chain has no validator MEV layer (Hyperliquid, Cosmos-SDK
  chains, Aptos, NEAR, Kaia, Sui, Cardano, Avalanche, Algorand, ICP,
  Gram), excluded on Ethereum (consensus layer only).
- Fees: excluded on the issuance-formula chains (Cosmos Hub, Sei,
  Cronos, Aptos, NEAR, Kaia); included in the measured ones (Cardano,
  Sui, Algorand proposer payouts, Gram elector bonuses).
- Uptime: real on Solana, Hyperliquid, Avalanche, Aptos (proposal
  success this epoch) and NEAR (online ratio this epoch); published as
  100 elsewhere.
- Synthetic rows (Ethereum, Algorand, ICP) carry the total stake in
  `stake_usd` and count as 1 in `ocb_chain_total_validators`.
- ICP is a governance yield, not a validator yield (node providers are
  paid separately), and depends on the neuron's dissolve delay: the row
  is the best-case profile a new staker can choose (2 years).
- Algorand pays only accounts that run their own participating node
  and opted in (30k to 70M ALGO); holding ALGO earns nothing.

## Metrics (port 2112, OCB convention)

```
ocb_validator_net_yield_bps{chain, validator, name}
ocb_validator_gross_yield_bps{chain, validator, name}
ocb_validator_mev_share_bps{chain, validator, name}
ocb_validator_commission_bps{chain, validator, name}   (not written for gram)
ocb_validator_uptime_pct{chain, validator, name}
ocb_validator_stake_usd{chain, validator, name}
ocb_validator_jailed{chain, validator, name}
ocb_chain_median_net_yield_bps{chain}
ocb_chain_total_validators{chain}
ocb_validator_scrape_errors_total{chain, source}
ocb_validator_last_scrape_timestamp_seconds{chain}
```

A validator that leaves a cohort has its series deleted on the next
scrape (`pruneLeavers`), so quantiles never read a departed validator.

## Rate limits

Keyless tiers are the constraint. Aptos (40k compute units / 5 min per
IP) and NEAR (FastNEAR free tier) need one view call per pool for the
commission; both are cached 6 h with at most 30 (Aptos) / 40 (NEAR)
lookups per scrape, so a cold start fills the cohort over 3 to 5
cycles (15 to 25 min) and a failed refresh keeps the stale value.
Prices come from ONE batched CoinGecko call shared by the new chains,
cached 10 min.

## Run locally

```bash
go build -o /tmp/vy ./cmd/script
VAL_ECON_METRICS_ADDR=:29112 /tmp/vy          # all chains
VAL_ECON_ONLY=near,aptos VAL_ECON_METRICS_ADDR=:29112 /tmp/vy
curl localhost:29112/metrics
```

`VAL_ECON_METRICS_ADDR` and `VAL_ECON_ONLY` are for local runs only;
deployments leave both unset. Every upstream URL is overridable with a
`VAL_ECON_*_URL` env var (see each scraper's `envDefault`).

## Deploy

Hardcoded `:2112`. The shared OCB Prometheus scrapes the container
`ocb-validator-yield:2112` (job `validator-yield`); new chains are new
`chain` label values on the same job, no scrape config change.
