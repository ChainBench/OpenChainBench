# server-wallet-cost

Bench 310: what each vendor bills for server and agent wallets, the ones a
company's backend or an AI agent holds and signs with, for three workloads
(AI agents, a trading bot, payouts) at any size.

A sibling of `harnesses/wallet-cost` (bench 309) with the same design and
the same rules: a human-verified catalogue, a Go model, Prometheus gauges, a
committed curve the calculator interpolates, an independent scorer, and an
hourly drift check on every pricing page. Read that README for the parts
that are identical; this one covers what differs.

## What differs from bench 309

- **Scenarios, not one axis.** Each scenario has its own axis x (agents, a
  bot's monthly transactions, payout wallets), and the month's active
  wallets and transactions are affine in it:
  `wallets = wallets_fixed + wallets_per_x * x`,
  `tx = tx_fixed + tx_per_x * x`. A meter is
  `per_wallet * wallets + per_tx * tx`. The bot's 20 wallets are a constant,
  so a wallet meter has no boundary along its axis.
- **`annual_usd`.** Dfns publishes annual prices; the catalogue writes them
  as published and the loader divides by twelve, so the drift check finds
  the page's own figure.
- **Units as published.** thirdweb prices server wallets per thousand
  requests, so its meter is `thousand_requests` and its rates are the page's
  $1, $0.60 and $0.20.
- **`bound`.** An uncertain price says which way the other reading goes:
  `upper` (the priced reading is the higher one, the bill is at most this)
  or `lower` (at least this). The curve carries it per point; the calculator
  names an upper-bound price as cheapest, never a lower-bound one.

## Running

    go test ./...
    go run ./cmd/script                       # /metrics on :2112, hourly

    # the calculator's curve, committed and checked by `pnpm validate`
    SERVER_WALLET_COST_EMIT_CURVES=../../src/data/server-wallet-cost-curves.json go run ./cmd/script

    # each page's pricing-sentence hash, and catalogue figures missing from it
    SERVER_WALLET_COST_PIN=1 go run ./cmd/script

    # the independent scorer, from the repository root
    node harnesses/server-wallet-cost/verify/scorer.mjs \
      harnesses/server-wallet-cost/pricing/catalogue.yml src/data/server-wallet-cost-curves.json

## Changing a price

Same four steps as bench 309: re-read and edit the catalogue with the hash
`SERVER_WALLET_COST_PIN=1` prints (keep its unpinned list empty), regenerate
the curve, run the scorer, and rebuild the VPS image in the same hour or
`ServerWalletCostSiteCurveMismatch` fires.

## Metrics

| Metric | Labels |
| --- | --- |
| `server_wallet_cost_monthly_usd` | provider, plan, kind, bucket |
| `server_wallet_cost_per_tx_usd` | provider, plan, kind, bucket |
| `server_wallet_cost_eligible` | provider, kind, bucket |
| `server_wallet_cost_plan_confidence` | provider, plan, kind, bucket |
| `server_wallet_pricing_artifact_ok`, `_drift`, `_age_seconds` | provider, artifact |
| `server_wallet_cost_last_run_timestamp_seconds` | |
| `server_wallet_cost_catalogue_info` | sha256, as_of |
| `server_wallet_cost_site_curve_matches` | branch |

`kind` is the scenario (`all` = agents) and `bucket` the size (`all` =
medium), on the same convention as bench 309.

Alerts are in `alerts.yml`, deployed as
`/opt/ocb/prom-rules/ocb_server_wallet_pricing.yml`.

## Environment

| Variable | Default |
| --- | --- |
| `SERVER_WALLET_COST_CATALOGUE` | `pricing/catalogue.yml` |
| `SERVER_WALLET_COST_INTERVAL` | `1h` |
| `SERVER_WALLET_COST_SITE_CURVES` | `dev=<raw GitHub URL>,main=<raw GitHub URL>` |
| `PORT` | `2112` |
