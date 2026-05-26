# Methodology - Relay.link Implied Protocol Revenue

> **Pre-registered methodology.** Pinned before any external party is invited to use the bench number for due diligence, deal terms, or commentary. Changes ship as public PRs with a 14-day comment window. Disputes go through public GitHub issues.
>
> **Version :** v1.0 - first commit 2026-05-23. Bench № 028 (Relay.link implied protocol revenue).

---

## 1. Question we answer

For Relay.link, the cross-chain swap routing protocol, **what is the smallest upper bound on the protocol revenue retained by Relay plus its solver network**, computed directly from the public swap stream over rolling 24-hour, 7-day, and 30-day windows.

The bench does **not** answer "what is Relay's bottom-line revenue net of solver share". That requires private rebate-accounting data Relay has never published. The bench answers "what is the ceiling, computed from the public data, on what Relay plus solvers collectively retain". Apply your own solver-share assumption to the headline if you need a Relay-only number.

## 2. Scope

| Dimension | Value |
|---|---|
| Protocol measured | Relay.link (single, no comparison set) |
| Data source | Relay.link public swap API |
| Poll cadence | 60 s |
| Windows | 24h, 7d, 30d (rolling) |
| USD reference | CoinGecko or equivalent at swap timestamp |
| Confidence | Status = `success` swaps only; pending / failed excluded |

Adding a comparison set (Across, Stargate, deBridge, etc.) would require each protocol to expose a similarly detailed swap API. As of v1.0, Relay is the only protocol in the bench. The page is deliberately framed as a single-protocol revenue tracker, not a comparative leaderboard.

## 3. Margin definition (exact)

For each successful swap:

```
per_swap_margin_usd =
    input_usd
  - output_usd
  - gas_usd
  - external_app_fees_usd
```

Where:

- `input_usd` = `input_token_amount * usd_price(input_token, swap_timestamp)`
- `output_usd` = `output_token_amount * usd_price(output_token, swap_timestamp)`
- `gas_usd` = `gas_used * gas_price * usd_price(chain_native_token, swap_timestamp)` summed across every chain leg the swap touches
- `external_app_fees_usd` = sum of any frontend / referrer fees the swap payload discloses

USD price is read at the swap timestamp, not at poll time, so a price move between swap and poll does not bias the margin.

## 4. Window aggregation

`relay_revenue_usd{window="24h"}` = sum of `per_swap_margin_usd` across every successful, priced swap completed in the last 24 hours.

Same for `window="7d"` and `window="30d"`. The windows are rolling, not calendar-aligned, so the 24h sum at time T covers (T - 24h, T].

`relay_volume_usd` and `relay_swap_count` follow the same window semantics.

`relay_take_rate_bps` = `(relay_revenue_usd{window="24h"} / relay_volume_usd{window="24h"}) * 10000`. Reported on the 24-hour window as the most recent operational signal. The 7d and 30d versions are derivable from the published gauges but not surfaced as their own gauge in v1.0.

## 5. Excluded swaps

- **Status not `success`.** Pending or failed swaps are not counted. They are tracked separately by the harness for operational visibility but do not appear in the margin sum.
- **Unpriced legs.** If any token in the swap (input, output, or gas-token leg) has no USD reference at swap time, the swap is excluded from the margin and volume sums and incremented into `relay_swaps_unpriced_total`. Successfully priced swaps go into `relay_swaps_priced_total`. The success column on the bench page is `priced / (priced + unpriced)`, a data-quality ratio.

The harness logs every excluded swap with reason so methodology audits can verify the exclusion rate is reasonable.

## 6. Why margin is an upper bound on Relay revenue

Relay shares revenue with its solver network through arrangements the public API does not break out. Per-swap margin captures what Relay AND its solver network collectively retain. Without access to internal rebate accounting, the bench cannot decompose the split. The headline is therefore the smallest upper bound consistent with the public data; the lower bound is open.

Public disclosures from comparable intent / settlement protocols (CowSwap, 1inch Fusion, UniswapX) suggest solver-share fractions in the 30 % to 70 % range depending on intent design. A reader building a Relay P&L model should pick a number in that range and apply it to the headline as `relay_only_revenue ≈ headline * (1 - solver_share)`.

## 7. Cross-validation expected band

Public disclosures (Relay public communications, on-chain volume trackers, comparable cross-chain protocol disclosures) put Relay daily volume at **$80M to $150M per day**.

Industry-standard cross-chain take rates cluster at **1 to 5 basis points blended**.

Multiplying the two ranges yields an expected protocol-revenue band of **$20k to $100k per day**, or **$0.75M to $2.5M per month**.

The live bench number is expected to fall inside this band. Meaningful deviation is either:
1. A data-quality issue (priced-swap ratio dropping, gas-estimation drift, undisclosed app fees rising, API change),
2. A regime change in Relay's volume or take rate worth investigating,
3. An error in the cross-validation assumptions that needs documenting.

The methodology section flags case 1 via the priced ratio and last-poll-timestamp gauges. Cases 2 and 3 are open research questions resolved through GitHub issues.

## 8. Metrics (Prometheus, exposed at `:2112/metrics`)

```
relay_revenue_usd{window}             gauge   # window: 24h | 7d | 30d
relay_volume_usd{window}              gauge   # window: 24h | 7d | 30d
relay_swap_count{window}              gauge   # window: 24h | 7d | 30d
relay_take_rate_bps                   gauge   # 24h window only
relay_swaps_priced_total              counter # cumulative since harness start
relay_swaps_unpriced_total            counter # cumulative since harness start
relay_last_poll_timestamp_seconds     gauge   # Unix timestamp of last successful poll
```

Label semantics:
- `window` ∈ {24h, 7d, 30d}

## 9. Bench page column mapping

The OpenChainBench leaderboard convention is p50 / p90 / p99 of a latency-like metric. For a revenue gauge there is no native percentile interpretation, so the three slots are repurposed:

- `p50` ← `relay_revenue_usd{window="24h"}` (latest 24h window)
- `p90` ← `relay_revenue_usd{window="7d"}` (rolling 7d sum)
- `p99` ← `relay_revenue_usd{window="30d"}` (rolling 30d sum)
- `mean` ← `relay_revenue_usd{window="7d"} / 7` (daily average over 7d)
- `series` ← `relay_revenue_usd{window="24h"}` (chart, evolves over time)
- `sample_size` ← `relay_swap_count{window="24h"}`
- `success` ← `relay_swaps_priced_total / (relay_swaps_priced_total + relay_swaps_unpriced_total)` (data-quality ratio, not service-uptime ratio)

This mapping is explicit on the bench page FAQ so readers do not misread the columns as actual percentiles.

## 10. Versioning rules

1. **Any** change to §3 (margin definition), §4 (window aggregation), §5 (excluded swaps), or §8 (metric names) ships as a public PR against this file with a 14-day comment window.
2. Adding a comparison protocol (e.g. Across, Stargate) requires a PR that extends §2 + §8 to cover the new protocol's swap source and is announced on the OpenChainBench blog with a 14-day window.
3. Pricing-source changes (CoinGecko to a different feed) require a PR with a side-by-side reconciliation showing the headline delta across at least one rolling 7-day window.
4. Solver-share decomposition (moving from upper-bound headline to a "Relay only" net headline) is a major version bump (v1 → v2) with a 30-day shadow-run period publishing both old and new metric series in parallel.

## 11. Reproducibility

The full harness source is published at `harnesses/relay-link-revenue/` in the OpenChainBench monorepo (Go). Anyone can clone, set the Relay.link API endpoint env var, configure a USD price source, run the binary against a Prometheus scraper, and reproduce all metrics. The bench does not rely on any internal Mobula service for measurement.

Anyone replicating the bench from a different USD-price source will see different absolute numbers (CoinGecko vs. Pyth vs. on-chain DEX price will disagree on long-tail tokens) but should see the same trend over a rolling 7-day window. Discrepancies of more than ~10 % in the 7d revenue sum between independent replications should be filed as GitHub issues with the price-source diff attached.

## 12. Limitations (explicit)

- **Upper bound only.** The headline is what Relay plus solvers collectively retain, not Relay's own revenue net of solver rebates. See §6.
- **Unpriced swaps reduce coverage.** Long-tail tokens without a USD reference at swap time drop out of the margin sum. The priced ratio (`success` column) makes this visible; readers should mentally scale the headline by `1 / priced_ratio` for an order-of-magnitude correction if needed.
- **Gas estimation drift.** `gas_used * gas_price` is read from the chain, but the USD conversion uses the swap-time native-token price, which can lag on volatile minutes. The error is bounded by the chain-native-token volatility over the swap interval (typically seconds) and is small relative to the per-swap margin.
- **External app fees only as disclosed.** If a frontend takes an undisclosed cut before the swap reaches Relay's API, that cut is not subtracted and the headline overestimates Relay+solver retention. The bench cannot see undisclosed fees by definition.
- **No comparison set in v1.0.** This is a single-protocol tracker. A future PR may add comparable cross-chain protocols once their public APIs expose enough detail to replicate the methodology.
- **Status field trust.** The bench trusts the Relay API's `status = "success"` field. A swap reported as success that actually failed on chain would be miscounted. The harness does not currently double-check status against on-chain state, this is a planned v1.1 hardening.

## 13. Sponsor independence

Sponsorship contracts (when present) follow the standard OpenChainBench public template:

- Sponsors fund operations and receive newsletter visibility, case studies, integration support. Never methodology influence, advance results, or selective publication.
- The non-suppression clause grants the sponsor a single remedy for unfavorable results: terminate the agreement and receive a pro-rata refund. Never edit, delay, or selectively publish.
- Methodology changes (this document) ship as PRs and are independent of sponsor contracts.
- Relay.link is not currently a sponsor and has no editorial influence on this bench.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| v1.0 | 2026-05-23 | Initial pre-registration. Single-protocol scope (Relay only), 24h / 7d / 30d windows, CoinGecko USD reference, 60 s poll cadence, upper-bound margin definition with explicit solver-share disclosure. |
