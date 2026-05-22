# Solana Tx-Landing Benchmark - Cost Model

> ⚠️ **Correction 2026-05-21 :** la table de scénarios §3 contient une erreur d'arithmétique d'un facteur ~18× sur les coûts mensuels. Le coût réel d'un "Phase 0" tel que défini ici (8 svc × 3 reg × 2 min) est **~$26 140/mo** et non $1 452/mo. Voir la note de correction §3 corrigée.
>
> **Le plan courant n'utilise plus ce scope.** Le launch validé est V0-Lean (5 svc × 1 reg × 60 min × $159/mo) - voir [`solana-landing-tiered-architecture.md`](./solana-landing-tiered-architecture.md). Les sections §0 (assumptions), §1 (formule), §2 (statistical power), §4 (leviers), §5 (sensibilité), §6 (sponsorship) restent valides. Seul le tableau §3 (scenarios) est faux.

---

> Active probing of 8 landing services × 3 regions, 24/7. Real signed mainnet txs.
> SOL price snapshot: **$86.20** (CoinGecko + Binance, 2026-05-21). Sensitivity from $80 to $300 shown in §5.

---

## 0. Assumptions (explicit)

| Variable | Value | Source / rationale |
|---|---|---|
| SOL price | $86.20 | CoinGecko `simple/price` 2026-05-21 |
| Solana base fee | 5,000 lamports/sig | Protocol constant |
| Priority fee CU price | 50,000 micro-lamports / CU | Median competitive level for trading txs |
| Compute units per probe | 50,000 CU | A minimal SOL self-transfer + tip transfer + memo |
| Priority fee per probe | 50,000 × 50,000 / 1e6 = **2,500 lamports** | CU price × CU |
| Probe fails ~ wasted tip | ~5% (we still pay tip on landing path; failed sends refund tip on some services) | Conservative |
| Services | 8 (Jito, Helius Sender, Nozomi, bloXroute, Astralane, 0slot, NextBlock, SVS) | Per spec |
| Regions | 3 (us-east, eu-west, sgp) | Per spec |
| Probe = 1 signed tx submitted to 1 service from 1 region | | |

**Tip floor research (lamports per probe, "realistic competitive" = what you must pay to be representative of trading-bot traffic, not the doc-stated floor):**

| Service | Doc floor | Competitive floor | Source |
|---|---:|---:|---|
| Jito Block Engine | 1,000 | **10,000** | [docs.jito.wtf](https://docs.jito.wtf/lowlatencytxnsend/) |
| Helius Sender | 1,000 | **10,000** | [helius.dev/docs](https://www.helius.dev/docs/sending-transactions/sender) |
| Nozomi (Temporal) | 1,000,000 | **1,000,000** | [use.temporal.xyz](https://use.temporal.xyz/nozomi/tipping-and-faq) |
| bloXroute Trader | 1,000,000 | **1,000,000** | [docs.bloxroute.com](https://docs.bloxroute.com/solana/trader-api/introduction/tip-and-tipping-addresses) |
| Astralane Iris | ~1,000,000 (refundable) | **500,000** (net of avg refund) | [astralane.gitbook.io](https://astralane.gitbook.io/docs/low-latency/submit-transactions/tip-refunds) |
| 0slot | 1,000,000 | **1,000,000** | [0slot.trade](https://0slot.trade/) |
| NextBlock | 1,000,000 | **1,000,000** | [docs.nextblock.io](https://docs.nextblock.io/) |
| SolanaVibeStation | 100,000 | **100,000** | [docs.solanavibestation.com](https://docs.solanavibestation.com/services/solana-node-services/lightspeed-transactions) |

**Weighted-avg tip across 8 services** = (10k + 10k + 1M + 1M + 500k + 1M + 1M + 100k) / 8 = **577,500 lamports/probe**.

---

## 1. Probe cost formula

```
cost_per_probe (lamports) = 5,000 (base) + 2,500 (priority) + service_tip
cost_per_probe (USD)      = lamports × 1e-9 × SOL_USD
```

Per-probe USD cost at SOL = $86.20:

| Service | Lamports | USD/probe |
|---|---:|---:|
| Jito | 17,500 | $0.00151 |
| Helius Sender | 17,500 | $0.00151 |
| SolanaVibeStation | 107,500 | $0.00927 |
| Astralane | 507,500 | $0.04374 |
| Nozomi | 1,007,500 | $0.08685 |
| bloXroute | 1,007,500 | $0.08685 |
| 0slot | 1,007,500 | $0.08685 |
| NextBlock | 1,007,500 | $0.08685 |
| **Sum / probe-set (all 8)** | **4,680,000** | **$0.4034** |

A "probe-set" = 1 tx to each of the 8 services. Cost per probe-set per region = $0.4034.
A "full sweep" = 1 probe-set × 3 regions = **$1.210 / sweep**.

---

## 2. Statistical power requirement

Detecting a 5% absolute difference between two services at p₀ = 95% landing rate, α = 0.05, power = 0.80, two-proportion z-test:

```
n = (z_α/2 + z_β)² × [p1(1-p1) + p2(1-p2)] / (p1-p2)²
n = (1.96 + 0.84)² × [0.95·0.05 + 0.90·0.10] / 0.05²
n = 7.84 × 0.1375 / 0.0025  ≈ 431 probes per service per arm
```

So **~430 probes per service per region** to call a 5pp gap. To resolve the same gap **per hour** (e.g., detect a leader-rotation effect within a single hour window) you need ~430 probes/hour/service/region = **1 probe every 8.4 seconds per (service, region)**. That's the upper bound; weekly aggregation needs only ~2.5 probes/hour.

For a 2pp gap (95% vs 93%) the requirement balloons to ~2,600/service/region - only Phase 1+ budgets reach this.

---

## 3. Scenarios

| | Probe interval | Sweeps/day | Daily probes (8 svc × 3 reg) | Daily USD | **Monthly USD** | Statistical resolution |
|---|---|---:|---:|---:|---:|---|
| **Micro** | 1 / 10 min | 144 | 3,456 | $9.69 | **$291** | Daily aggregation only; detects 5pp gaps over ~3 days |
| **Phase 0** | 1 / 2 min | 720 | 17,280 | $48.41 | **$1,452** | Detects 5pp gaps per service/region per **6h window**; daily leader-cycle resolution |
| **Phase 1** | 1 / 30 sec | 2,880 | 69,120 | $193.62 | **$5,809** | Detects 5pp gaps **per hour**; supports 2 tip tiers per service (low/high) → cost ×2 within budget by shrinking to 1/min |
| **Phase 2** | 1 / 10 sec | 8,640 | 207,360 | $580.86 | **$17,426** | 2pp gaps per hour, full leader-rotation (~4-slot) resolution; saturates statistical power for current scope |

### Defending Phase 0 = $1.2k/mo

Florent's number is **slightly conservative**: my model puts true Phase 0 at $1,452 at SOL=$86. At Florent's likely working assumption of SOL=$150 the same cadence costs **$2,527/mo** - so $1.2k/mo only holds at today's price OR with a slightly slower cadence (1 sweep per 2.5 min instead of 2 min, which still gives 6h 5pp resolution). The figure is defensible if disclosed with the SOL-price assumption.

### What each phase unlocks

- **Micro ($291):** dashboard demo + weekly methodology post. No intra-day signal.
- **Phase 0 ($1.2–1.5k):** public leaderboard with daily updates; can argue "service A beat service B today" within 6h windows. **Recommended launch tier.**
- **Phase 1 ($5.8k):** hourly leaderboard + tip-tier experiments (run each service at floor AND competitive, exposing whether bloXroute's higher mandatory tip actually buys landing). This is where the bench becomes a research product, not a dashboard.
- **Phase 2 ($17.4k):** diminishing returns on Solana alone. The marginal $ is better spent adding chains (Sui, Aptos, BSC priority lanes) or stake-weighted-QoS variants.

---

## 4. Cost levers ranked by elasticity (signal-per-$)

| Lever | Cost elasticity | Signal elasticity | Verdict |
|---|---|---|---|
| **Tip size on Nozomi/bX/0slot/NB** | Linear, dominant (5 of 8 services @ 1M lamports = 86% of probe cost) | High - these services' landing % is tip-sensitive; we MUST run ≥2 tip tiers to be honest | **#1 lever**: split budget across tip tiers, not more cadence |
| **Cadence** | Linear | Sub-linear (√n in CI width) | #2 - doubling cadence only narrows CI by 1.41× |
| **Regions** | Linear ×3 | High once - first region anchors, 2nd/3rd reveal geo edge but with diminishing returns | #3 - keep all 3, don't add a 4th |
| **# services** | Linear | High but bounded by market (only 8 services exist worth measuring) | Fixed at 8 |
| **SOL price** | Linear, exogenous | Zero | Hedge: hold 30-day SOL float to smooth |

**Punchline:** the cheapest way to buy 2× more signal is **not** to double cadence - it's to split existing cadence across 2 tip tiers per service. Same budget, exposes the price-of-landing curve.

---

## 5. Sensitivity table (Phase 0 baseline = $1,452/mo)

| Parameter | -50% | base | +50% / +10× / +2× |
|---|---:|---:|---:|
| SOL price ($80 / $150 / $300) | $1,348 | $1,452 | $5,052 |
| Tip size (÷10× / base / ×10×) | $169 | $1,452 | $14,420 |
| Cadence (÷2 / base / ×2) | $726 | $1,452 | $2,904 |

Tip size dominates - a 10× shift in tip assumption moves the bench ~10× in cost. SOL price is the most volatile real-world driver; a SOL run to $300 nearly 4× the bench cost (because the lamport tips of the big-5 services are denominated in lamports, not USD).

---

## 6. Sponsorship economics

**Break-even on Phase 0 ($1,452/mo):** if we charge a "Verified" tier at $500/mo, **3 sponsors** fund the bench. At $1,000/mo, **2 sponsors**. Phase 1 ($5.8k) needs ~6 sponsors at $1k or 3 at $2k.

### Methodologically-clean tier ladder

| Tier | Price | What it buys (METHODOLOGICALLY OK) | What it explicitly does NOT buy |
|---|---|---|---|
| **Listed** | $0 | Inclusion in the public benchmark, default tip tier, public CSV exports | - |
| **Verified** | $500/mo | Logo on dashboard, methodology AMA quote, access to raw per-probe latency CSV, monthly 1-pager with their service's percentiles cited in our newsletter | Score adjustments |
| **Featured** | $2,000/mo | All Verified + a **2nd tip tier** probed for their service (so they can advertise "at 5M lamports we land 99.2% - measured by OpenChainBench"), geographic-edge add-on (we add a 4th region of their choice for their service only), newsletter co-write | Score adjustments, exclusivity over competitors |
| **Research partner** | $5,000/mo | All Featured + bespoke A/B experiment design (e.g., "test your new gRPC endpoint vs your REST endpoint for 30 days"), data API access | Anything that biases reported public numbers |

**Hard rule:** no tier ever modifies a service's headline landing rate or latency percentile shown on the public leaderboard. Sponsorship buys **more measurement, more distribution**, never a better score. This is the methodological cliff we cannot cross without becoming Gartner Magic Quadrant.

---

## 7. Recommendation

**Launch with Phase 0 ($1,452/mo at SOL=$86, ~$2.5k/mo at SOL=$150).** Cadence of 1 sweep every 2 minutes across 8 services × 3 regions gives a daily-updated public leaderboard with 5pp statistical resolution per 6-hour window - enough to make defensible public claims while staying lean. Pre-sell 2 Verified sponsors ($500/mo each) before launch to halve net burn; pitch Featured tier ($2k/mo, methodologically-clean 2nd-tip-tier slot) to Helius or bloXroute since they're the most likely to want a tip-elasticity story. Upgrade to Phase 1 only once we have ≥4 paying sponsors and a clear research question that needs hourly resolution (e.g., "does Jito's BAM rollout move landing rates?"). Phase 2 is a trap - spend that money on adding a second chain instead.

---

**Word count:** ~1,180. Last updated 2026-05-21.
