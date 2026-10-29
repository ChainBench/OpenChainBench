# wallet-cost

Bench 309: what each embedded wallet vendor bills the same app, at any size
from 100 to 1,000,000 monthly active users.

The harness holds no keys and creates no wallets. Its input is
`pricing/catalogue.yml`, a human-verified catalogue of every vendor's
published plans; its work is to apply each vendor's own billing rules to
three usage profiles and to keep checking that the vendors' pages still say
what the catalogue says.

## The model

For a profile (transactions per user, share of users who are new) and an app
size in MAU, every quantity a vendor meters is linear in MAU:

    meter = per_user x MAU + per_tx x transactions + per_new_wallet x new wallets

Each plan has a fee, graduated tiers per meter on the total quantity (the
first tier at rate 0 is what the plan includes), `caps` where it cannot serve
more, `quote_above` where its published price stops, and optionally
`minimum: true` when the fee is a spending floor. The bill is the fee plus the
tier charges (or the larger of the two for a minimum); the vendor's bill is
its cheapest eligible plan. `profile_exclusions` honours a vendor's own
statement that its self-serve plans are not for a kind of app.

`catalogue.yml` explains every vendor's reading in its `note`, and marks a
plan `confidence: uncertain` (or `uncertain_above` a quantity) wherever the
page can be read two ways. The validator fails closed on the shapes that
publish a plausible wrong price instead of an error: a missing rate, a price
attached to a quote, a meter no plan bounds, a misspelt key.

## Running

    go test ./...                       # model, validation, curve exactness
    go run ./cmd/script                 # serve /metrics on :2112, hourly cycle

    # the calculator's curve, committed and checked by `pnpm validate`
    WALLET_COST_EMIT_CURVES=../../src/data/wallet-cost-curves.json go run ./cmd/script

    # each source page's current pricing-lines hash, to record after a re-read
    WALLET_COST_PIN=1 go run ./cmd/script

## Changing a price

1. Re-read the vendor's page and edit `pricing/catalogue.yml`, with the new
   `verified_at` and the hash `WALLET_COST_PIN=1` prints for that page.
2. Regenerate the curve (command above). `pnpm validate` refuses a curve
   built from a different catalogue byte for byte.
3. Re-run the independent scorer, a second implementation in another
   language, from the repository root. It re-prices every curve point and
   30,000 random app sizes per vendor and profile, and exits non-zero on
   any disagreement:

       node harnesses/wallet-cost/verify/scorer.mjs \
         harnesses/wallet-cost/pricing/catalogue.yml src/data/wallet-cost-curves.json
4. Rebuild the harness image on the VPS: the catalogue ships inside it.
   Until then the site's calculator (built from the new curve) and the
   bench's ledger (read from this harness) quote different prices. Check
   that `wallet_cost_catalogue_info{sha256=...}` equals `catalogueSha256`
   in `src/data/wallet-cost-curves.json`.

## Metrics

| Metric | Labels |
| --- | --- |
| `wallet_cost_monthly_usd` | provider, plan, kind, bucket |
| `wallet_cost_per_user_usd` | provider, plan, kind, bucket |
| `wallet_cost_eligible` | provider, kind, bucket |
| `wallet_cost_plan_confidence` | provider, plan, kind, bucket |
| `wallet_pricing_artifact_ok`, `_drift`, `_age_seconds` | provider, artifact |
| `wallet_cost_last_run_timestamp_seconds` | |
| `wallet_cost_catalogue_info` | sha256, as_of |
| `wallet_cost_site_curve_matches` | branch |

`kind="all"` is the consumer profile and `bucket="all"` 10,000 users, each
on its own axis, the same convention as rpc-cost.

## Freshness

Six of the first thirteen pages return a new body on every request while their
prices stand still, so a raw-body hash would alarm every hour. The harness
hashes the page's pricing sentences instead: visible text split at sentence
and clause ends, keeping each sentence that carries a dollar figure, a
number beside a billing word, or a bare band range ("1,001-5,000"), sorted
and de-duplicated. A rule with no number in it is kept by naming a phrase in
the source's `pin_phrases` (Reown: "custom plan").

`WALLET_COST_PIN=1` prints each page's current hash and every figure the
catalogue takes from that vendor that is absent from the hashed lines. Keep
that list empty: a figure outside it can change with no drift. On
2026-10-29 it was empty for all fourteen, Portal included.

Alerts (`alerts.yml`, deployed as `/opt/ocb/prom-rules/ocb_wallet_pricing.yml`
and tested with `promtool test rules`):

| Alert | Fires when |
| --- | --- |
| `WalletPricingArtifactDrift` | a page's pricing lines differ from the recorded hash for 6 hours |
| `WalletPricingArtifactUnreachable` | a page has not answered with pricing lines for 6 hours |
| `WalletCostSiteCurveMismatch` | a site branch's curve was built from another catalogue than this harness runs, for 2 hours |

The last one reads `wallet_cost_site_curve_matches{branch}`: each cycle the
harness fetches `src/data/wallet-cost-curves.json` from the dev and main
branches on GitHub and compares its `catalogueSha256` with its own. A branch
without the file publishes nothing.

## Environment

| Variable | Default |
| --- | --- |
| `WALLET_COST_CATALOGUE` | `pricing/catalogue.yml` |
| `WALLET_COST_INTERVAL` | `1h` |
| `WALLET_COST_SITE_CURVES` | `dev=<raw GitHub URL>,main=<raw GitHub URL>` |
| `PORT` | `2112` |
