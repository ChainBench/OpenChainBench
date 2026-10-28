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

What *is* live is the freshness check. Each cycle the harness re-fetches
the polled artifacts (the ones not marked `poll: manual`), hashes the
body, and compares against the hash recorded when the catalogue was last
verified. When a provider edits its pricing, `rpc_pricing_artifact_drift`
goes to 1. That is an alarm for the maintainers, not a display: the bench
page reads the committed curve (`src/data/rpc-cost-curves.json`) and shows
the catalogue date, and it changes only when a human re-reads the page and
the catalogue and curve are re-committed.

Sixteen of the nineteen ranked providers publish a machine-readable
artifact (JSON API or raw markdown), listed per provider under `source:`
in the catalogue. Live parsing of the four unauthenticated JSON pricing
APIs (GetBlock, NOWNodes, QuickNode, Tatum) is the obvious next step and deliberately
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
   These differ structurally: Chainstack bills 2 Request Units for a read
   127 or more blocks behind the tip and 2 for every `debug_*` and
   `trace_*` call at any depth (measured: 2 RU even ten blocks behind tip),
   BlockPI adds 30% to the whole endpoint, GetBlock
   carries an independent archive column that is not a multiplier at all,
   and Alchemy, dRPC, QuickNode, Dwellir and Blockmachine charge no
   archive premium (Blockmachine bills debug and trace at 25 to 50 Request
   Units instead, a per-method weight rather than an archive rule).
3. Picks the provider's cheapest plan that can actually serve the
   workload, and reports the bill on that plan.

A plan that cannot serve the workload is not priced at infinity, it is
reported ineligible with a reason (`rpc_cost_eligible` = 0, and the reason
in the log and the calculator). The reasons, all real, fall into five
groups (`quote()` in `model.go`):

- **Not priced.** The provider prices no plan for the chain, the price is
  sales-gated, or a method in the mix has no published unit cost.
- **Not served.** The plan does not serve the chain or a method the mix
  calls (Dwellir's Free plan has no `eth_getLogs`), or it has no archive
  or trace access. Where the provider has not said either way, the plan
  is not ranked rather than assumed capable.
- **Daily caps.** Infura's allowance is per day and does not roll over,
  so 450M credits of monthly demand cannot be served by a 15M/day plan
  even though the monthly totals match.
- **Hard stops and ceilings.** Infura, NOWNodes Start/Pro and QuickNode's
  trial stop at the cap rather than metering overage; some plans publish
  a maximum, or an allowance with no overage rate.
- **Throughput.** The sustained rate the volume needs exceeds the plan's
  published ceiling (Alchemy's 30,000 CU/s, counted in throughput CU, ends
  its trace curve at about 128M requests a month).

## Cohorts

`usage` providers bill per request and are the ranked cohort. `dedicated`
providers sell capacity per month or per node-hour; the spec declares that
tier `ranked: false`, and the bench page prices them in the calculator,
on the same curve as the metered plans, rather than in the per-workload
grid. `rpc_cost_breakeven_requests` is still emitted (the monthly volume at
which a fixed price undercuts the cheapest metered rate) but no panel reads
it yet. Mixing the two into one $/1M column would let a volume assumption
decide the ranking.

`excluded` providers stay in the catalogue with a reason so the bench can
say publicly why something is absent — including the ones that died
(Grove, LlamaRPC, Blast API) and the ones that publish no
price at all (Tenderly).

## Metrics

```
rpc_cost_monthly_usd{provider,plan,kind,bucket,chain,tier,venue}
rpc_cost_per_million_usd{provider,plan,kind,bucket,chain,tier,venue}
rpc_cost_units_per_request{provider,kind,chain}
rpc_cost_eligible{provider,kind,bucket}
rpc_cost_plan_confidence{provider,plan,kind,bucket}
rpc_free_allowance_requests{provider,plan,kind,chain}   (+ _floor, _ceiling)
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
