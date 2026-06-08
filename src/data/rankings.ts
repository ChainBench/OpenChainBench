/**
 * Rankings pages — keyword-optimized landing pages that surface an existing
 * benchmark under a search-intent URL (e.g. `/rankings/fastest-l1-finality`
 * maps onto `/benchmarks/l1-finality`).
 *
 * Each entry is a small editorial layer on top of a Benchmark — it does not
 * fetch its own Prometheus data, it reuses the parent bench's leaderboard
 * and adds:
 *   - an SEO-tuned H1 + meta tuned to a head-term query (e.g. "fastest L1
 *     blockchain finality").
 *   - ≥300 words of unique editorial intro written here in code (not
 *     auto-generated at render time, to avoid the thin-programmatic-content
 *     filter that Google's Helpful Content Update cracked down on in 2024).
 *   - a curated FAQ list scoped to the head-term, not the bench's own
 *     methodology FAQ.
 *
 * The leaderboard data still comes live from Prom via the parent bench, so
 * a ranking page is never stale beyond the ISR window of the bench it
 * mirrors. We deliberately keep this list small (≤15 entries) to avoid
 * tripping site-reputation / scaled-content classifiers. Adding a ranking
 * page is a deliberate editorial act, not a bulk generator.
 */

export type RankingPage = {
  /** URL slug under /rankings/. */
  slug: string;
  /** Bench slug whose leaderboard this page reuses. */
  benchmark: string;
  /** Optional chain dimension to filter the leaderboard (e.g. "ethereum"). */
  chain?: string;
  /** H1 + browser title — head-term phrasing, not internal bench title. */
  title: string;
  /** ~155 char meta description, head-term phrasing. */
  metaDescription: string;
  /** OpenGraph + Twitter card subtitle. ~70 chars. */
  subtitle: string;
  /** Editorial intro — written once, ≥300 words. Markdown supported. */
  intro: string;
  /** 3–5 question/answer pairs scoped to the head-term, not the bench. */
  faq: { q: string; a: string }[];
};

export const RANKINGS: RankingPage[] = [
  {
    slug: "fastest-l1-finality",
    benchmark: "l1-finality",
    title: "Fastest L1 blockchain finality in 2026",
    metaDescription:
      "Live ranking of the fastest Layer 1 blockchains by observed finality, measured every 10 seconds at each chain's own finalized tag. Methodology open, data live.",
    subtitle: "Wall-clock finality across 10 Layer 1 blockchains, updated continuously.",
    intro: `When people ask which Layer 1 blockchain is the fastest, they usually mean throughput (transactions per second). That number is largely meaningless without the matching finality figure — the point at which a confirmed transaction can no longer be reorganized out of the chain. A chain that produces blocks every 400 milliseconds but takes 13 seconds to finalize them is not really 400 ms fast for any application that needs settlement guarantees.

This ranking measures observed wall-clock finality across 10 production Layer 1 chains, refreshed every 10 seconds for HTTP-polled chains and continuously over WebSocket for BNB Chain and Avalanche. Each chain is read against its own protocol-defined finalized tag — Casper FFG for Ethereum, the finalized commitment level on Solana, the solidity confirmation on TRON, the masterchain seqno on TON, and industry-standard confirmation depths for the proof-of-work chains. The reported value is the p50 over a rolling 24-hour window, in seconds.

What stands out in the live data: TON consistently leads at sub-second finality, with SUI and BNB Chain close behind. Avalanche and Stellar sit in the 1–4 second range. Solana lands around 13 seconds, which matches its 32-slot finalization commitment. TRON's solidity confirmation comes in at roughly a minute. Ethereum's Casper FFG finality runs in the 15–20 minute range under typical mainnet conditions — for context, this is the protocol-level guarantee, not the exchange-confirmation depths that Coinbase (35 blocks, ~7 minutes), Binance (12 blocks, ~2.4 minutes), or Circle (65 blocks, ~13 minutes) actually use to credit deposits. Monero and Litecoin trail at 20+ minutes by design.

Finality matters most for three classes of application: cross-chain bridging (a bridge can only safely release funds on chain B once the source transaction on chain A is irreversible), exchange settlement (deposit credits, withdrawal release), and smart contract conditions that depend on cross-chain or cross-block state. For pure user-experience metrics like "did my transfer go through", soft confirmation (single-block inclusion) is usually enough — but soft confirmation is not finality, and treating them as equivalent is the most common source of misleading L1 marketing.

The harness is open source. Every reading on this page is a public Prometheus query that you can reproduce from a clean clone.`,
    faq: [
      {
        q: "What is blockchain finality?",
        a: "Finality is the point at which a confirmed transaction can no longer be reorganized out of the chain. Different chains define it differently: deterministic finality (Casper FFG on Ethereum, BFT on Cosmos chains) gives a hard cutoff after a fixed number of slots, while probabilistic finality (used by proof-of-work chains like Bitcoin, Litecoin, Monero) treats finality as a confidence threshold that grows with each additional confirmation.",
      },
      {
        q: "Why is Ethereum slower than Solana in this ranking?",
        a: "The ranking measures protocol-level finality — Ethereum's Casper FFG takes about 64 slots (12–15 minutes) to mark a block as finalized. Solana's finalized commitment is reached after 32 slots, which translates to roughly 13 seconds. For practical user experience, both chains feel near-instant for single-block confirmation; the 15-minute number is only relevant when an application needs the hardest possible cryptoeconomic settlement guarantee.",
      },
      {
        q: "How does TON achieve sub-second finality?",
        a: "TON uses the BFT-style finality of its masterchain consensus. The reading on this page measures wall-clock distance between the latest masterchain block and the third-most-recent seqno, which TON nodes treat as final under the chain's own settlement convention.",
      },
      {
        q: "Where does this data come from?",
        a: "Every L1 in the ranking is queried directly from a public RPC or a tonapi.io / blockchair / koios endpoint. The harness exposes the raw values as a Prometheus gauge, and the leaderboard pulls the p50 over a 24-hour window using quantile_over_time. No third-party aggregator is involved — the source is the chain itself.",
      },
      {
        q: "Can I reproduce these numbers?",
        a: "Yes. The harness source is open at github.com/ChainBench/OpenChainBench/tree/main/harnesses/l1-finality. Clone, run docker compose up, and the same metrics appear on localhost:2112/metrics within 30 seconds. Pull requests welcome for chains we haven't added yet.",
      },
    ],
  },
  {
    slug: "most-stable-stablecoin",
    benchmark: "stablecoin-peg",
    title: "Most stable USD-pegged stablecoin in 2026",
    metaDescription:
      "Live ranking of stablecoins by peg deviation in basis points, computed from a liquidity-weighted median across USD-quoted venues. Updated continuously.",
    subtitle: "Live peg deviation across major USD-pegged stablecoins.",
    intro: `The "stablecoin" label hides a wide spread of actual price behavior. The headline issuers — Circle for USDC, Tether for USDT, MakerDAO for DAI — all advertise a 1:1 peg to the US dollar, but the price you actually see on exchanges depends on liquidity, redemption mechanics, and demand pressure. A coin trading at $0.998 looks identical to one at $1.002 from a chart perspective, but both represent real economic friction for traders, market makers, and any application that needs precise USD-denominated settlement.

This ranking measures live peg deviation in basis points, computed as the absolute distance from $1.00 of a liquidity-weighted median price taken across the USD-quoted venues where the coin trades. USDC samples are drawn from Kraken USDCUSD, Bitstamp usdcusd, and Binance USDCUSDT (with the USDT pair handled separately as a secondary metric so USDT's own peg deviation doesn't contaminate the USDC reading). USDT is read from Kraken USDTUSD and Bitstamp usdtusd. DAI uses Curve 3pool's get_dy in both forward and reverse directions, since the on-chain Curve price is itself the price-of-record for most DAI flows. FDUSD and USDe are observed via their primary USDT pairs on Binance and reported under a USDT-anchored secondary metric.

The aggregation is bucketed per minute, with the liquidity-weighted median computed across venues for that minute, then the p50 over the rolling 24-hour window is reported as the headline figure. Outliers more than 20% off peg are dropped; samples in the 10–20% off-peg range are capped at 10% to avoid letting a single illiquid venue distort the percentile.

In the current live data, DAI typically sits closest to peg, in the 2 basis-point range, reflecting the Curve liquidity behind it. USDT runs wider, in the 5–8 basis-point range, which reflects its higher trading velocity and the redemption frictions that exist around US banking hours. The bench also computes a cross-venue gap — the maximum minus minimum price across USD-quoted venues for any given minute — which surfaces the windows where Coinbase quotes one price and Kraken quotes another. That gap is the operational metric that matters most to anyone running arbitrage or treasury operations.

A depeg-event flag is emitted when the per-minute aggregated price stays outside the [0.97, 1.03] band for 5 consecutive minutes, and clears after 30 minutes back inside. The threshold is deliberately conservative so it does not flap during normal stress windows.`,
    faq: [
      {
        q: "What does \"peg deviation\" mean in basis points?",
        a: "One basis point equals 0.01%, so a peg deviation of 5 bps means the coin is trading 0.05% away from $1.00. A 100-bps deviation would be a 1-cent gap on a $1 coin. For context, a perfectly stable coin would show 0 bps; in practice, the best-performing stablecoins under normal market conditions live in the 1–5 bps range.",
      },
      {
        q: "Why is the price taken from multiple venues instead of one?",
        a: "Single-venue prices can drift away from the broader market for venue-specific reasons (deposit/withdrawal windows, regional liquidity, exchange outages). A liquidity-weighted median across multiple USD-quoted venues gives a price that better represents what a market participant could actually transact at, and is much harder to manipulate.",
      },
      {
        q: "Why is USDT measured against USDT-anchored pairs separately?",
        a: "Some stablecoins (FDUSD, USDe) only have deep liquidity in USDT-quoted pairs, not USD-quoted pairs. Including their USDT-quoted price in a USD-anchored peg measurement would import USDT's own deviation into their reading. We keep those samples in a secondary metric so the primary leaderboard is not contaminated.",
      },
      {
        q: "Which stablecoins are intentionally excluded?",
        a: "Aggregator-only prices from CoinGecko, CoinMarketCap, and DefiLlama are excluded because those are themselves liquidity-weighted medians of the venues we already poll directly. Algorithmic stablecoins that have already failed (UST, USDR) are out of scope; this bench only tracks live, currently-redeemable stables.",
      },
      {
        q: "Is the data live?",
        a: "Yes. CEX samples are pulled every 5 seconds, on-chain Curve get_dy every 12 seconds (matching Ethereum block time). The leaderboard's p50 reflects the rolling 24-hour window and the page refreshes through ISR within a minute of a new run.",
      },
    ],
  },
  {
    slug: "cheapest-cross-chain-bridge",
    benchmark: "bridge-fee",
    title: "Cheapest cross-chain bridges in 2026",
    metaDescription:
      "Live ranking of cross-chain bridge fees, including aggregator commission, gas, and slippage. Real quote requests against production endpoints.",
    subtitle: "Total bridge cost (fee + gas + slippage) across major bridges.",
    intro: `Bridge fee marketing is misleading on purpose. A "0% fee" bridge can still charge you 30 basis points in slippage and 200 dollars in destination gas, and the fee number that ends up on the landing page hides both. This ranking measures the total cost a user actually pays — including the bridge's commission, the realized slippage from the quote, and the destination gas as quoted in the response — for live quote requests against each bridge's production endpoints.

The methodology is direct: for a defined route (typically a stable-to-stable transfer on a fixed notional), the harness fires a real quote request at each bridge's quote API in parallel, parses the returned commission, slippage, and gas figures, and computes a single implied total. The total is normalized to basis points of the notional so that bridges quoting in different units can be compared apples to apples. Sampling cadence is 60 seconds per route, with a rotating basket of routes across Ethereum, Arbitrum, Base, Optimism, and BNB Chain so a bridge's pricing on one chain pair doesn't dominate its overall ranking.

What the data shows: native bridges with no aggregator markup (e.g. the canonical Optimism bridge, Arbitrum's native bridge) often have the lowest pure fee but the slowest finality, which the cheap headline number doesn't reflect. Intent-based bridges like Across and Relay tend to be the cheapest end-to-end once gas and slippage are included on short routes, because they amortize gas across multiple users and the solver competition compresses the spread. LI.FI and deBridge sit in the middle and act as routers, picking the cheapest path at quote time. Stargate and Hop run wider on small notionals due to fixed fee components.

The reading on each row is the median realized cost over the 24-hour rolling window in basis points. The p99 column shows the worst-case scenario over the same window, which matters more than the median when the cost spike happens at exactly the moment you need to bridge. A bridge with a 5 bps p50 and a 200 bps p99 is more expensive in expectation than a bridge with a 12 bps p50 and a 15 bps p99, even though the headline number says the opposite.

A few caveats. Bridge fees vary by notional — quotes on $1,000 may not extrapolate to quotes on $1,000,000. The ranking is therefore best read as relative ordering at the notional we test, not as an absolute price guarantee for any specific transaction.`,
    faq: [
      {
        q: "What counts as a \"bridge fee\" here?",
        a: "Total user-paid cost: the bridge protocol's commission (or solver spread on intent bridges) plus realized slippage from the quote plus destination gas as quoted by the bridge. All three are summed and normalized to basis points of the transfer notional. A bridge that quotes a 0% fee but a 30 bps slippage shows up as 30 bps total, not 0.",
      },
      {
        q: "Why are intent-based bridges often cheaper?",
        a: "Intent bridges (Across, Relay, deBridge) amortize destination gas across many concurrent users and let solvers compete on the spread. On short, high-volume routes this competition drives the realized cost below the fixed-fee structures of older lock-and-mint or burn-and-mint bridges.",
      },
      {
        q: "Does this measure security?",
        a: "No. This bench measures fee only. Security models — multisig, optimistic, ZK proof, intent-based — differ across bridges and are out of scope here. A cheap bridge is not automatically a safe bridge; the fastest finality is not automatically the most resistant to operator capture. Consult a security audit before bridging high-value notional.",
      },
      {
        q: "Why does the headline change throughout the day?",
        a: "Bridge fees are reactive: solver inventory, gas spikes, and route-specific demand all shift the realized cost minute to minute. The p50 over the rolling 24-hour window smooths the highest-frequency noise but still reflects time-of-day patterns. A bridge that's cheapest at 03:00 UTC may not be cheapest at 14:00 UTC.",
      },
      {
        q: "Can I see the raw quote data?",
        a: "Every reading is a public Prometheus query, exposed at /api/series/bridge-fee. The harness source is at github.com/ChainBench/OpenChainBench — clone, run, and the quotes appear on localhost:2112/metrics. The exact route basket is documented in the harness README.",
      },
    ],
  },
];

export function getRanking(slug: string): RankingPage | undefined {
  return RANKINGS.find((r) => r.slug === slug);
}

export function getRankingSlugs(): string[] {
  return RANKINGS.map((r) => r.slug);
}
