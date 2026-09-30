# rpc-cost

What each RPC provider actually bills for a given workload, and how stale
that answer is.

| Bench | Measures | How |
|---|---|---|
| RPC provider cost | Monthly USD bill and effective $/1M requests per provider, per workload profile, per volume | Applies each provider's own published billing rules to five fixed workload mixes at three volumes, hourly |

## Why this is not a scraper

Most of the cohort publishes pricing as prose on a marketing page. A
parser that guesses at prose produces numbers that look authoritative and
are wrong, which is worse than no bench. So the input of record is
`pricing/catalogue.yml`: a committed, human-verified file where every
figure carries the artifact it came from and the date a human read it.

What *is* live is the freshness check. The harness re-fetches every
source artifact each cycle, hashes the body, and compares against the
hash recorded when the catalogue was last verified. When a provider edits
its pricing, `rpc_pricing_artifact_drift` goes to 1 and the bench page
says the numbers are behind — instead of serving a stale figure that
still reads as current.

Eleven of the twelve ranked providers do publish a machine-readable
artifact (JSON API or raw markdown), listed per provider under `source:`
in the catalogue. Live parsing of the three true JSON pricing APIs
(GetBlock, NOWNodes, QuickNode) is the obvious next step and deliberately
not in this first version: drift detection has to be trustworthy before
auto-ingestion is.

## The model

`rpc_cost_monthly_usd` is the bill, not a rate card. For each (provider,
profile, volume) the harness:

1. Computes weighted billing units per request from the provider's own
   method table and the profile's method mix. This is the step that makes
   a Compute Unit, a Request Unit and a credit comparable at all, and it
   is published as `rpc_cost_units_per_request` so the arithmetic can be
   redone by hand.
2. Applies the archive rule where the profile reads historical state.
   These differ structurally: Chainstack doubles by *block age* rather
   than by method, BlockPI adds 30% to the whole endpoint, GetBlock
   carries an independent archive column that is not a multiplier at all,
   and Alchemy, dRPC and QuickNode charge no archive premium.
3. Picks the provider's cheapest plan that can actually serve the
   workload, and reports the bill on that plan.

A plan that cannot serve the workload is not priced at infinity, it is
reported ineligible with a reason (`rpc_cost_eligible` = 0). Three cases
produce that, all real:

- **Daily caps.** Infura's allowance is per day and does not roll over,
  so 450M credits of monthly demand cannot be served by a 15M/day plan
  even though the monthly totals match.
- **Hard stops.** Infura, NOWNodes Start/Pro and QuickNode's trial stop
  serving at the cap rather than metering overage.
- **Missing capability.** A trace workload on a plan without debug
  access is unavailable, not expensive.

## Cohorts

`usage` providers bill per request. `dedicated` providers sell capacity
per month or per node-hour and are ranked on their own axis, with
`rpc_cost_breakeven_requests` giving the monthly volume at which the
fixed price undercuts the cheapest metered rate. Mixing the two into one
$/1M column would let a volume assumption decide the ranking.

`excluded` providers stay in the catalogue with a reason so the bench can
say publicly why something is absent — including the ones that died
(Grove, LlamaRPC, InstantNodes, Blast API) and the ones that publish no
price at all (Tenderly).

## Metrics

```
rpc_cost_monthly_usd{provider,plan,profile,bucket,chain,cohort}
rpc_cost_per_million_usd{provider,plan,profile,bucket,chain,cohort}
rpc_cost_units_per_request{provider,profile,chain}
rpc_cost_eligible{provider,profile,bucket}
rpc_cost_breakeven_requests{provider,plan,chain}
rpc_pricing_artifact_ok{provider,artifact}
rpc_pricing_artifact_age_seconds{provider,artifact}
rpc_pricing_artifact_drift{provider,artifact}
rpc_cost_last_run_timestamp_seconds
```

## Run it

```bash
go run ./cmd/script            # serves :2112/metrics
```

No API keys. No RPC traffic is sent to any provider — the only outbound
requests are HTTP GETs of public pricing pages for the freshness check.

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `2112` | metrics port |
| `RPC_COST_CATALOGUE` | `pricing/catalogue.yml` | catalogue path |
| `RPC_COST_INTERVAL` | `1h` | cycle interval; pricing pages do not move hourly, this paces the freshness check |

## Maintaining the catalogue

Pricing changes. When `rpc_pricing_artifact_drift` fires, re-read the
artifact, update the figures, and bump `verified_at` and `body_sha256`
for that source. Do not bump the hash without re-reading the numbers —
that is the one action that silently defeats the whole mechanism.

Provider membership is hand-picked on purpose. No public directory of RPC
providers exists (chainlist strips the vendor field, DefiLlama has no RPC
category, ethereumnodes.com is frozen circa 2022), and the two registries
that come close list "vendors my product supports" and omit Helius,
Validation Cloud and Triton entirely.
