# paymaster-cost

Bench 312: what each vendor bills a developer for sponsoring its users' gas
through an ERC-4337 paymaster (or a bundler that sponsors), on Base,
Arbitrum and Ethereum, at any volume of sponsored user operations a month.

A sibling of `harnesses/server-wallet-cost` (bench 310), with the same
design and the same rules: a human-verified catalogue, a Go model,
Prometheus gauges, a committed curve the calculator interpolates, an
independent scorer, and an hourly drift check on every pricing page. Read
`harnesses/wallet-cost/README.md` for the parts that are identical; this one
covers what differs.

## What differs from bench 310

- **The gas is not in the bill.** A sponsored operation burns the same gas
  whoever sponsors it. Each bill is what the vendor charges on top: plan
  fee, per-operation or per-request charge, and the surcharge on the gas.
  The page states the gas beside it.
- **A scenario is a chain.** Its axis is sponsored user operations a month
  and `gas_usd_per_tx` is the gas one operation burns there, measured from
  EntryPoint v0.7 `UserOperationEvent` logs (method and blocks in the
  catalogue header). A surcharge meter is `{ per_gas_usd: 1 }` and its rate
  is the percentage as a fraction.
- **A vendor may be pinned by two pages.** CDP states its markup in the
  paymaster FAQ and its billing units on the node pricing page; Etherspot
  its price on etherspot.io and its credits per method in its docs; Alchemy
  its fee, its BSO surcharge wording and its CU table on three. The PIN
  report checks figures against a vendor's pages together, reads "10%" as
  0.10 and "$1 per 100,000 credits" as 0.00001 a credit.
- **The gas figure is a snapshot.** Re-measure it when a chain's fees move
  (Ethereum follows the base fee) and bump the scenario: the scorer fails
  on a scenario that differs from the curve.

## Running

    go test ./...
    go run ./cmd/script                       # /metrics on :2112, hourly

    # the calculator's curve, committed and checked by `pnpm validate`
    PAYMASTER_COST_EMIT_CURVES=../../src/data/paymaster-cost-curves.json go run ./cmd/script

    # each page's pricing-sentence hash, and catalogue figures missing from it
    PAYMASTER_COST_PIN=1 go run ./cmd/script

    # the independent scorer, from the repository root
    node harnesses/paymaster-cost/verify/scorer.mjs \
      harnesses/paymaster-cost/pricing/catalogue.yml src/data/paymaster-cost-curves.json

## Changing a price

Same four steps as bench 309: re-read and edit the catalogue with the hash
`PAYMASTER_COST_PIN=1` prints (keep its unpinned list empty and read
every `stray=` figure: a page that still states an old price elsewhere
passes the unpinned test while its card changed), regenerate
the curve, run the scorer, and rebuild the VPS image in the same hour or
`PaymasterCostSiteCurveMismatch` fires.

## Metrics

| Metric | Labels |
| --- | --- |
| `paymaster_cost_monthly_usd` | provider, plan, kind, bucket |
| `paymaster_cost_per_tx_usd` | provider, plan, kind, bucket |
| `paymaster_cost_eligible` | provider, kind, bucket |
| `paymaster_cost_plan_confidence` | provider, plan, kind, bucket |
| `paymaster_pricing_artifact_ok`, `_drift`, `_age_seconds` | provider, artifact |
| `paymaster_cost_last_run_timestamp_seconds` | |
| `paymaster_cost_catalogue_info` | sha256, as_of |
| `paymaster_cost_site_curve_matches` | branch |

`kind` is the chain (`all` = base) and `bucket` the size (`all` =
medium), on the same convention as bench 309.

Alerts are in `alerts.yml`, deployed as
`/opt/ocb/prom-rules/ocb_paymaster_pricing.yml`.

## Environment

| Variable | Default |
| --- | --- |
| `PAYMASTER_COST_CATALOGUE` | `pricing/catalogue.yml` |
| `PAYMASTER_COST_INTERVAL` | `1h` |
| `PAYMASTER_COST_SITE_CURVES` | `dev=<raw GitHub URL>,main=<raw GitHub URL>` |
| `PORT` | `2112` |

## What the drift check does not see

The hourly check hashes each page's pricing sentences and the PIN report
lists catalogue figures missing from them: plan fees, tier rates and
bounds, surcharges, caps and quote thresholds. It does not check meter
coefficients (Pimlico's 1,050 credits, Alchemy's 3,520 CU, Etherspot's
1,625 credits, ZeroDev's 20 credits an operation); the method tables they
come from are hashed (`pin_phrases`), so a change there drifts, but the
sum is ours. Re-add it by hand whenever one of those pages drifts.
