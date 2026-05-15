/**
 * Glossary entries. One file, hand-written, no external source.
 *
 * Each entry maps a technical term to a sober, technical definition.
 * Pages at /glossary and /glossary/<slug> render directly from this data.
 *
 * Adding a term: drop a new entry below. The page route picks it up at
 * build time via generateStaticParams. No restart needed in dev.
 */

export type GlossaryEntry = {
  slug: string;
  /** Display term (capitalised, includes notation). */
  term: string;
  /** One-line summary. shown in the index and as the meta description. */
  short: string;
  /** Full definition. Plain text, may span multiple paragraphs split by
   *  blank lines. No markdown. */
  body: string;
  /** Optional related-term slugs. rendered as cross-links at the foot of
   *  each definition. */
  related?: string[];
  /** Benchmark slugs that exemplify this term in practice. */
  seeAlso?: string[];
};

export const GLOSSARY: GlossaryEntry[] = [
  {
    slug: "p50-latency",
    term: "p50 latency",
    short: "The median response time across a sample. Half the calls are faster, half are slower.",
    body: `p50 is the 50th percentile of a latency distribution. If you ran the same call 100 times and sorted the response times, p50 is the figure in position 50.

Why p50 instead of an average. A handful of slow outliers can drag a mean to a number that no real user ever experienced. The median is robust to those tails and reflects the typical response time. It is the figure that most realistic consumers will see most of the time.

OpenChainBench reports p50 as the headline figure on every latency benchmark. p90 and p99 sit next to it so readers can see the spread.`,
    related: ["p90-p99-latency", "head-lag"],
    seeAlso: ["aggregator-head-lag", "bridge-quote-latency"],
  },
  {
    slug: "p90-p99-latency",
    term: "p90 and p99 latency",
    short: "Tail-end percentiles. p90 catches slow requests, p99 catches the slowest one in a hundred.",
    body: `p90 is the 90th percentile. nine calls in ten finish at or below this number. p99 is the 99th percentile. one call in a hundred is slower than this.

These are the figures that matter when a slow response breaks the user experience. A bridge with p50 = 200ms and p99 = 8000ms is fine on average but will lock up your front end on roughly one quote in a hundred.

In a healthy distribution, p99 sits within a small multiple of p50 (often 3x to 10x). A wide gap is a strong signal of timeouts, retries, or a noisy upstream.`,
    related: ["p50-latency"],
  },
  {
    slug: "head-lag",
    term: "head lag",
    short: "Time between an on-chain swap landing in a block and it appearing in a provider's API or stream.",
    body: `Head lag is measured from the wall-clock moment a transaction is included in a block to the moment a downstream provider exposes that transaction through its public API or WebSocket feed.

The figure is dominated by three factors. how fast the provider reads from the chain, how aggressively it caches and indexes, and how it pushes to consumers. A fast WebSocket with redundant ingestion typically clocks 200-800ms head lag. A slow REST endpoint that polls a third-party RPC can run several seconds behind the tip.

Head lag matters for any consumer that wants to react to live activity. liquidations, MEV bots, alerting systems, dashboards.`,
    related: ["p50-latency"],
    seeAlso: ["aggregator-head-lag"],
  },
  {
    slug: "quote-latency",
    term: "quote latency",
    short: "Time for a bridge or aggregator to return a usable route + fee + estimated settlement time.",
    body: `Quote latency is the wall-clock duration of a single quote request. start when the request leaves the client, stop when a parseable response arrives with a route, fee, and ETA.

Distinct from settlement latency, which is the time the bridge or aggregator takes to actually move the funds. A bridge can quote in 200ms and settle in 12 minutes. We measure both separately.

Quote latency is the figure UIs are bound by. a wallet that takes three seconds to display a swap is unusable, even if the underlying route is great.`,
    related: ["p50-latency"],
    seeAlso: ["bridge-quote-latency"],
  },
  {
    slug: "all-in-fee",
    term: "all-in fee",
    short: "Every cost the user pays on a swap or bridge: explicit fee, spread, gas markup, and slippage.",
    body: `An all-in fee is the difference between the input notional and the value the user actually receives, expressed as a percentage. It captures everything. the protocol fee, the spread embedded in the price, any gas markup, and the slippage from a thin order book.

Why this matters for comparison. Bridges that publish a low explicit fee may compensate by widening the spread on the quote. Aggregators that route through a relay can show a 0% explicit fee but eat 50bps in the underlying intent leg. The all-in figure is the only honest way to compare an intent network, a relayed bridge, and a protocol that charges its own fee.

We measure all-in fees by quoting identical routes at identical notionals across every venue, then comparing the output the user would actually receive.`,
    related: ["intent", "relayer"],
    seeAlso: ["bridge-fee"],
  },
  {
    slug: "intent",
    term: "intent (intent-based architecture)",
    short: "A swap or bridge model where the user signs what they want, not how to execute. Solvers compete to fill.",
    body: `In an intent-based system, the user signs a declarative message. "I want X token on chain A for Y token on chain B by time T". A network of solvers competes to fill that intent, often by holding inventory on both sides and settling between themselves later.

The trade-off versus a pool-based protocol. Intents typically settle faster (the solver fronts the destination side immediately) and price aggressively (solvers compete on spread). The cost is in the spread, not the explicit fee. so an intent network with "0% fee" can still be more expensive than a 30bp protocol fee if the spread is wider.

Intent networks include Across, Relay, and CoW Swap. They are not directly comparable to pool-based bridges without normalising to all-in fee.`,
    related: ["all-in-fee", "relayer"],
    seeAlso: ["bridge-fee", "bridge-quote-latency"],
  },
  {
    slug: "relayer",
    term: "relayer",
    short: "A third-party operator that pays gas on a user's behalf and gets reimbursed in the swap output.",
    body: `Relayers are the actors that execute on-chain transactions for users who hold no native gas on the destination chain. The user signs an off-chain message, the relayer broadcasts the transaction and pays the gas, and the relayer's fee is netted out of the output.

Relayers are foundational to gasless UX, intent networks, and most cross-chain bridges that bill themselves as instant. They overlap with solvers but are typically a narrower role. A solver designs the route, a relayer executes it.`,
    related: ["intent", "all-in-fee"],
  },
  {
    slug: "finality",
    term: "finality",
    short: "The point at which a transaction is considered irreversible by economic or cryptographic guarantee.",
    body: `Finality is the moment a transaction can no longer be reverted without breaking the chain's security assumptions.

Two flavours dominate. Probabilistic finality (Bitcoin, PoW Ethereum pre-merge) where reversal becomes exponentially unlikely as blocks pile on. Each chain has a convention. six blocks for Bitcoin, twelve for legacy Ethereum.

Deterministic or BFT finality (Solana, BNB, Avalanche, SUI, TON, post-merge Ethereum at the finalised checkpoint) where reversal requires a supermajority of validators to break protocol rules. The transaction is either final or it is not.

OpenChainBench measures wall-clock finality from on-chain inclusion to the conventional finality marker, not from theoretical protocol specs. We anchor to the depth that major centralised exchanges use for credit on each chain, since that is the figure with real economic meaning.`,
    related: ["confirmation-depth"],
    seeAlso: ["l1-finality"],
  },
  {
    slug: "confirmation-depth",
    term: "confirmation depth",
    short: "How many blocks (or finality markers) a chain waits before treating a transaction as settled.",
    body: `Confirmation depth is the number of subsequent blocks that must arrive on top of a transaction before consumers treat it as final. Conventions vary by chain and by the consumer's risk tolerance.

Bitcoin uses six. legacy Ethereum used twelve. Solana uses one finalised slot. BNB uses a single finalised block. Smaller chains often use a number tuned for their fork frequency.

OpenChainBench's l1-finality benchmark uses the depth each major exchange uses for credit, since those numbers are the result of years of operational tuning by deposit-handling teams.`,
    related: ["finality"],
    seeAlso: ["l1-finality"],
  },
  {
    slug: "sample-size",
    term: "sample size",
    short: "The number of measurements that fed into a benchmark's headline figure over the run window.",
    body: `Sample size is the count of individual probes that produced the percentile figures. A 24-hour benchmark running one probe per minute has up to 1440 samples per provider. A bridge benchmark that cycles four routes by three notionals every five minutes runs at 3456 daily samples.

We expose sample size on every benchmark so readers can decide how seriously to take a given figure. A p99 from 50 samples is statistically noisy. A p99 from 10000 samples is solid.`,
    seeAlso: ["aggregator-head-lag"],
  },
  {
    slug: "success-rate",
    term: "success rate",
    short: "The share of probes that returned a usable response, excluding timeouts and errors.",
    body: `Success rate counts the probes that returned a valid response over all probes that fired, expressed as a percent.

A common failure mode that drags success rate down. timeouts (the provider did not respond within the harness's deadline), HTTP errors (rate limits, 500s, gateway issues), and malformed payloads (the response parsed but lacked the field we were measuring).

Failed probes are excluded from the latency percentiles. Otherwise a single timeout at the harness's 4-second ceiling would tank a provider's p99. We report success rate as a separate figure so the trade-off is visible.`,
    related: ["sample-size"],
  },
  {
    slug: "isr",
    term: "ISR (Incremental Static Regeneration)",
    short: "A Next.js rendering mode that serves static HTML and regenerates it on a fixed interval.",
    body: `ISR is the strategy OpenChainBench uses to serve fresh benchmark figures without paying server cost on every request.

The flow. Next.js prerenders every benchmark page at build time. Each page is tagged with a revalidation window (we use 60 seconds). When a request comes in, the static HTML is served instantly. If the page is older than its window, a background regeneration is triggered and the next request gets the fresh version.

This means readers always get a static-fast response, but the data is never more than a minute stale.`,
    related: [],
  },
];

export function getGlossaryEntry(slug: string): GlossaryEntry | undefined {
  return GLOSSARY.find((g) => g.slug === slug);
}

export function getGlossarySlugs(): string[] {
  return GLOSSARY.map((g) => g.slug);
}
