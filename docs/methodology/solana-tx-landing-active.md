# Methodology - Solana TX Landing (Active Probing)

> **Pre-registered methodology.** Pinned commit before any sponsor contract is signed. Changes ship as public PRs with a 14-day comment window. Disputes go through public GitHub issues.
>
> **Version :** v1.0 - first commit 2026-05-21. Bench № 016 (Solana TX Landing).
> **Replaces / extends :** the observational tip-wallet attribution methodology that ships with the same bench page (kept as the "Market Share" tab).

---

## 1. Question we answer

For each Solana transaction landing service, **how long does it take for a transaction submitted via that service to be confirmed on mainnet, and what fraction never confirms within a usable window** - measured from a single fixed geographic origin, on a uniform synthetic payload, at a uniform cadence.

The bench does **not** answer "which service is best for your trading bot" - that requires modeling your own payload size, tip elasticity, and venue. The bench answers "what is the typical, comparable, reproducible time-to-land per service today."

## 2. Scope (V0-Lean launch)

| Dimension | Value |
|---|---|
| Services probed | 5 - Jito Block Engine, Helius Sender, Astralane Iris, Nozomi (Temporal), 0slot.trade |
| Region | 1 - Railway us-east (Newark / NY area) |
| Cadence | 1 cycle per hour |
| Duration | continuous, 24 / 7 |
| Window for headline metrics | rolling 7-day weekly leaderboard |
| Confirmation level | `confirmed` (1+ block confirmation) |

Services and regions are added through the public escalation rules in [`solana-landing-tiered-architecture.md`](../solana-landing-tiered-architecture.md). Any expansion is a PR + 14-day window - never a silent change.

## 3. Probe payload (exact)

Every probe is a single Solana transaction containing three instructions, in this order :

1. `ComputeBudgetProgram.SetComputeUnitLimit(50 000)` - caps compute units.
2. `ComputeBudgetProgram.SetComputeUnitPrice(50 000 micro-lamports)` - priority fee per CU.
3. `SystemProgram.Transfer(from = prober keypair, to = prober keypair, lamports = 1)` - the payload itself, self-transfer of 1 lamport. Solana requires non-zero state-touching for a tx to be valid; self-transfer is the minimum honest payload.
4. `SystemProgram.Transfer(from = prober keypair, to = <service tip wallet>, lamports = <service tip floor>)` - the tip required by the landing service.
5. `MemoProgram.Memo("ocb-<cycle_id>-<service>-<mode>")` where `cycle_id` is a per-cycle 8-byte random hex generated once and shared across all per-service probes in the cycle. This lets us correlate the 5 simultaneous probes on-chain.

The exact tip amount per service is published as part of this methodology and frozen unless a methodology PR amends it :

| Service | Tip lamports | Source / justification |
|---|---:|---|
| Jito Block Engine | 10 000 | "Competitive" floor per docs.jito.wtf - above 1 000 doc minimum, below 50th-percentile observed real-traffic tip |
| Helius Sender | 10 000 | Same with `?swqos_only=true` (isolates Helius own path from Jito fan-out) |
| Astralane Iris | 500 000 | Mid-range net of refunds per astralane.gitbook.io |
| Nozomi (Temporal) | 1 000 000 | Hard floor per use.temporal.xyz/nozomi/tipping-and-faq |
| 0slot.trade | 1 000 000 | Hard floor per 0slot.trade |

We do **not** vary tip amount across cycles. A "tip elasticity" experiment is a separate, sponsored methodology PR.

## 4. Submission flow (per service, per cycle)

1. Fetch a recent blockhash via the public mainnet RPC (`api.mainnet-beta.solana.com`) with `commitment = "processed"`. The same blockhash is used for all services in the same cycle so they share a chain-state reference point. `processed` is preferred over `confirmed` because the resulting blockhash is fresher (~400 ms vs ~6 s); the marginal fork risk is acceptable since landing services dedup on signature, not blockhash.
2. Build the transaction described in §3 for that service (the tip-transfer differs per service).
3. Sign with the region's persistent keypair. The signature is known at this point, before any network call.
4. **Subscribe to the signature via `signatureSubscribe` on the public mainnet WebSocket** (`wss://api.mainnet-beta.solana.com`) at `commitment = "confirmed"`. The subscription is registered **before submission** so a fast-confirming tx cannot complete before we are listening (otherwise we would miss the notification and incorrectly timeout).
5. Capture `submit_slot = getSlot(commitment="processed")` and `submit_wallclock = time.Now()`.
6. POST the base64-encoded signed transaction to the service's documented submission endpoint (exact URLs published in the harness source) with `skipPreflight = true`, `maxRetries = 0`, `encoding = "base64"`. Per-service auth headers / query params are applied as documented.
7. Capture the returned signature (or fail-fast on RPC error).
8. Block on the `signatureNotification` push from the WebSocket. On notification, record `land_slot` from the notification context and `land_wallclock = time.Now()`. Classify as **landed**. Resolution is RTT-bounded (~30-50 ms us-east → mainnet-beta) since the RPC pushes the notification the instant the commitment level is reached, with no client polling cadence floor.
9. **Fallback:** if the WebSocket connection fails to establish at the start of the cycle (transient network issue, RPC overload), every probe in that cycle falls back to HTTP polling of `getSignatureStatuses` every 200 ms. This preserves bench continuity but adds a ~200 ms quantization penalty for the affected cycle. The fallback path is logged.
10. If 60 seconds elapse without a notification (or without a non-null `confirmationStatus` on the polling fallback), abandon the wait. Classify as **dropped** with reason `timeout`.
11. If the original submission returned a transport error (HTTP timeout, DNS, EOF, connection refused), classify as **dropped** with reason `network_error`. If the upstream returned HTTP 419 / 429 or a JSON-RPC error containing "rate limit" / "too many requests", classify as `rate_limited`. If the submission was rejected with a structured RPC error (`InstructionError`, `BlockhashNotFound`, etc.) or the on-chain status comes back with an `Err`, classify as `invalid`.

The 5 services for a given cycle are submitted **in parallel** (Go goroutines) so they sample the same congestion window. The order of `submit_slot` reads is arbitrary but all reads happen within 200 ms.

## 5. Metrics (Prometheus, exposed at `:2112/metrics`)

```
solana_landing_probe_success_total{service, mode, region}              counter
solana_landing_probe_dropped_total{service, mode, region, reason}      counter
                                                                        # reason: timeout | invalid | network_error | rate_limited

solana_landing_probe_latency_slots{service, mode, region}              gauge   (last observed slot delta)
solana_landing_probe_latency_slots_histogram{service, mode, region}    histogram
                                                                        # buckets: 1, 2, 3, 5, 10, 20, 50, 100

solana_landing_probe_latency_ms{service, mode, region}                 gauge   (last observed wall-clock ms)
solana_landing_probe_latency_ms_histogram{service, mode, region}       histogram
                                                                        # buckets: 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000

solana_landing_probe_keypair_balance_sol{region}                       gauge
solana_landing_probe_keypair_low_balance_total{region}                 counter
solana_landing_probe_cycle_total{region}                               counter
solana_landing_probe_last_cycle_timestamp_seconds{region}              gauge
solana_landing_probe_enabled{region}                                   gauge
                                                                        # 1 when prober configured + running, 0 in pure observational mode
```

The `rate_limited` reason groups responses where the upstream service returns HTTP 419 / 429 or a JSON-RPC error containing "rate limit" / "too many requests". Reported separately from `invalid` because rate-limiting is a quota/operational state, not a landing-quality signal.

**Label semantics :**

- `service` ∈ {jito, helius-sender, astralane, nozomi, 0slot}
- `mode` is set on `service = helius-sender` only and takes values `swqos_only` or `dual` (other services: `mode = "default"`)
- `region` ∈ {us-east} (V0-Lean); will expand under §7

**Headline metrics** displayed publicly on the bench page :

- `landing_rate = success_total / (success_total + dropped_total{reason="timeout"})` over the last 7 days
- `p50_latency_ms` and `p99_latency_ms` over the last 7 days, per service, per region
- `p50_slot_delta` and `p99_slot_delta` over the last 7 days, per service, per region

## 6. Jito control probe

Three services (Helius default mode, Astralane Iris, Nozomi) submit a portion of their flow through Jito internally. Without controlling for this, their measured landing time conflates "this service's own path" with "Jito's auction outcome via this service".

The Jito control probe is the standard Jito-direct probe **fired in the same cycle as the suspect services**, with the same tip floor (10 000 lamports) and same blockhash. If a suspect service consistently lands at the same `submit_slot + Δ` as the Jito control, the suspect service is interpreted as a Jito routing wrapper for that cycle. We do not currently publish a derived "service-net-of-Jito" metric, but the raw data supports such derivation.

For Helius we additionally probe in `?swqos_only=true` mode in every cycle (see §3) to publish a clean Helius-only metric series.

## 7. Versioning rules

1. **Any** change to §3 (payload), §4 (submission flow), §5 (metric definitions), or the per-service URLs ships as a public PR against this file with a 14-day comment window before merge.
2. Adding a new service requires a PR that updates §2 + §3 + §5 and is announced on the OpenChainBench blog with a 14-day window. Removing a service same.
3. Tip-amount changes (§3) require a PR with a written explanation of why the new amount better reflects "competitive" floor.
4. Region additions and cadence changes are PR + 14-day window.
5. Metric removal or label rename is **prohibited within a version**. Such changes require a major version bump (v1 → v2) with a 30-day shadow-run period publishing both old and new metric families in parallel.

## 8. Reproducibility

The full harness source is published at `mobula-api/miniapps/solana-tx-landing/` (Go). Anyone with a funded Solana keypair (~1 SOL) can clone, set the `SOLANA_PROBE_KEYPAIR_BASE58` env var, run the binary, and reproduce all metrics. The bench does not rely on any internal Mobula service for measurement.

Anyone replicating the bench from a different geographic origin will see different absolute latencies (since service POPs vary by region) but should see the same relative ranking trends over a 7-day window. Discrepancies of more than 1 percentile rank between independent replications should be filed as GitHub issues.

## 9. Statistical power statement

At V0-Lean cadence (1 / h × 1 region × 5 services) a single service accumulates 168 probes per rolling 7-day window. With this sample size :

- `p50_latency_ms` standard error ≈ ±5 % at typical service variance
- `p99_latency_ms` standard error ≈ ±15 % (broad; published with confidence interval)
- Difference in `landing_rate` between two services detectable at 5 pp gap, p < 0.05, after ~18 days of data

For sub-weekly resolution, cadence must increase. The escalation path is in [`solana-landing-tiered-architecture.md`](../solana-landing-tiered-architecture.md) §7.

## 10. Limitations (explicit)

- **Single-region**: latency reflects what a us-east client sees. Services with non-us-east-anchored POPs may rank differently from sgp or eu-west.
- **Synthetic payload**: a 1-lamport self-transfer + memo is the smallest valid mainnet tx. Real trading payloads (Jupiter swap, Raydium add-liquidity) are heavier and may behave differently in tip elasticity. The bench does not extrapolate.
- **Fixed tip per service**: the bench measures landing performance *at one tip level*. A service that lands at 99 % for 1 M lamports may land at 50 % for 100 k lamports. The bench does not characterize the tip elasticity curve in V0-Lean.
- **Fan-out attribution**: §6 partially handles Helius / Astralane / Nozomi fan-out via the Jito control probe, but does not produce a derived "service-net" published metric in V0-Lean.
- **Confirmation level**: we use `confirmed` (1+ confirmation). A service that lands at `processed` but never reaches `confirmed` would be undercounted. We do not currently publish a `processed` series.
- **Mainnet incidents**: when Solana mainnet halts or congests beyond 60-second confirmation, all services rank identically high in `dropped{reason=timeout}`. The bench page must surface a "chain health overlay" so readers can distinguish service problems from chain problems.
- **Geographic biases**: services with no us-east POP (none in the V0-Lean scope) are penalized vs services with one. We disclose POP locations in the bench page methodology block.

## 11. Sponsor independence

Sponsorship policy and the disclosure block live in [`solana-landing-tiered-architecture.md`](../solana-landing-tiered-architecture.md) §6. The contract template enforces :

- Sponsors fund operations and receive newsletter visibility, case studies, integration support. Never leaderboard influence, advance results, or methodology changes.
- The non-suppression clause grants the sponsor a single remedy for unfavorable results : terminate the agreement and receive a pro-rata refund. Never edit, delay, or selectively publish.
- Methodology changes (this document) ship as PRs and are independent of sponsor contracts.

## 12. Change log

| Version | Date | Change |
|---|---|---|
| v1.0 | 2026-05-21 | Initial pre-registration. V0-Lean scope : 5 services × 1 region × 1 / h. |
| v1.1 | 2026-05-21 | Pre-launch reconciliation with implementation : metric names from `ocb_solana_landing_*` to `solana_landing_probe_*` (matches sibling OCB benches), `rate_limited` added as 4th drop reason, latency_ms histogram bucket list adjusted to include 250 ms and 30 s, blockhash commitment rationale clarified, memo format clarified (`ocb-<cycle_id>-<service>-<mode>` where cycle_id is itself the 8-byte random hex shared across all per-service probes in the cycle), `solana_landing_probe_enabled` gauge added so dashboards distinguish "prober disabled" from "prober stuck". |
| v1.2 | 2026-05-23 | `getSignatureStatuses` poll interval reduced from 1 s to 200 ms after the first 7 days of live data showed all services collapsing to identical 1.0 s p50. The 1 s poll was the measurement floor (Solana confirmed status arrives in ~400 ms-1 s), so 200 ms restores 5x the resolution. Bench page queries also switched from `histogram_quantile` on the latency_ms histogram to `quantile_over_time` on the latency_ms gauge, since the histogram bucket list only had ~3 buckets in the 1-5 s zone where probes actually land, collapsing p50 to bucket midpoints. |
| v1.3 | 2026-05-23 | Primary observation path switched from HTTP polling to `signatureSubscribe` over the public mainnet WebSocket (`wss://api.mainnet-beta.solana.com`). The RPC pushes the notification at the instant the commitment level is reached, so resolution is RTT-bounded (~30-50 ms us-east → mainnet-beta) rather than poll-cadence-bounded. Subscription is registered BEFORE submission to prevent missing fast confirmations. HTTP polling at 200 ms remains an automatic fallback if the WebSocket connect fails. Validated locally against mainnet-beta with end-to-end slot and signature subscribe tests before deploy. |
| v1.4 | 2026-05-23 | Nozomi endpoint switched from `https://ewr.nozomi.temporal.xyz/` (Newark, region-pinned) to `http://edge.nozomi.temporal.xyz/` (geo-routed DNS, HTTP). Reason: Railway us-east is Ashburn, the previous endpoint forced a cross-region hop adding ~30 ms RTT. The geo-routed DNS resolves to the POP closest to the caller. HTTP instead of HTTPS skips the TLS handshake on the hot path (Solana tx is already signed so plain-text body is not a confidentiality risk - the signature is public the moment the tx is on chain). Change requested by Jakob @ Temporal Labs on 2026-05-23 and applied to all probes from the same region. The same review pass is open for Jito / Helius / Astralane / 0slot - any service whose **publicly-documented** best-practice configuration differs from what we currently probe is invited to file an issue or PR. We do NOT accept private deals to alter the probe surface for any single service; we DO apply optimisations that the service publishes as their standard production recommendation. |
| v1.5 | 2026-05-24 | Two further Nozomi refinements per Jakob @ Temporal Labs follow-up. (a) Endpoint moved from `edge.nozomi.temporal.xyz` (JSON-RPC sendTransaction) to `http://use.temporal.xyz/api/sendBatch?c=<KEY>` (binary `[u16_BE_len][tx_bytes]` framing, `Content-Type: application/octet-stream`). Per Jakob, this batch endpoint handles single-tx submissions and is the path most clients use. Implementation: single-tx wrap in the batch container. (b) Tip wallet switched from the saturated main wallet `TEMPaMeCRFAS9EKF53Jd6KpHxgL47uWLcpFArU1Fanq` to a non-saturated wallet `nEFs3jph8HJt7honu3k7XtGUufMnwAvSXmXcKSPxryP` recommended by Jakob; the main wallets receive heavy MEV-load traffic and clients typically rotate over less-busy alternates. The `TEMPaMe...` wallet remains in the Nozomi tip-wallet list as a fallback for the v1 anti-fingerprint randomisation feature. No change to tip floor (1 000 000 lamports). |
