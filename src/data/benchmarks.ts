/**
 * Benchmark dataset — placeholder figures with realistic shape, ready to be
 * swapped for live numbers from the open-source benchmark scripts.
 *
 * Source repos for the actual harnesses (when wired in):
 *   - mobula/openchainbench-aggregator-bench
 *   - mobula/openchainbench-bridge-bench
 *   - mobula/openchainbench-feed-bench
 */

export type Highlight = "winner" | "neutral" | "loser";

export type ProviderResult = {
  /** Display name */
  name: string;
  /** Short slug for stable references */
  slug: string;
  /** Optional short tagline (chain coverage, runtime, etc) */
  tag?: string;
  /** Latency stats in milliseconds */
  ms: {
    p50: number;
    p90: number;
    p99: number;
    mean: number;
  };
  /** Reliability — % of requests returning a usable result within the timeout */
  successRate: number;
  /** Optional secondary metric, units vary per benchmark */
  secondary?: { label: string; value: string };
  highlight?: Highlight;
};

/** Per-region p50 latency for the small-multiples map. */
export type RegionPoint = {
  region: "us-east" | "eu-west" | "ap-southeast" | "global";
  p50: number;
};

/** Optional time-series for sparklines: 24 hourly p50 values, ms. */
export type Series24h = number[];

export type ResultExtras = {
  series24h: Record<string, Series24h>;
  regions: Record<string, RegionPoint[]>;
};

export type Benchmark = {
  slug: string;
  number: string;
  title: string;
  subtitle: string;
  /** ISO date string of last run */
  lastRunAt: string;
  /** Status of the dataset */
  status: "live" | "draft";
  /** Sample size of the latest run */
  sampleSize: number;
  /** One-paragraph editorial summary, plain text */
  abstract: string;
  /** Key metric label, used in headers */
  metric: string;
  /** Unit suffix on the metric */
  unit: string;
  /** Categories used on the index page */
  category: "Aggregators" | "Bridges" | "Data" | "Wallets" | "RPCs";
  /** Result rows, sorted from best to worst */
  results: ProviderResult[];
  /** Editorial findings rendered as paragraphs */
  findings: string[];
  /** Methodology bullets specific to this benchmark */
  methodology: string[];
  /** GitHub path to the harness */
  source: string;
  /** Extras for richer data viz — sparklines and region breakdowns. */
  extras: ResultExtras;
};

/** Deterministic pseudo-random series — same seed → same shape, no flicker. */
function series(seed: number, base: number, jitter = 0.18, length = 24): number[] {
  const out: number[] = [];
  let s = seed * 9301 + 49297;
  for (let i = 0; i < length; i++) {
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280;
    const drift = Math.sin(i / 3.2 + seed) * jitter * base * 0.6;
    const noise = (r - 0.5) * jitter * base;
    out.push(Math.max(0.5, base + drift + noise));
  }
  return out;
}

const ISO = (d: string) => new Date(d).toISOString();

/**
 * Mock benchmark data — used at build time when Prometheus is unreachable
 * or when no spec has been authored yet. The async loaders below overlay
 * live Prometheus numbers on top of these (see `src/lib/spec.ts`).
 *
 * Add a YAML file under `benchmarks/<slug>.yml` to wire a benchmark to
 * Prometheus. The slug must match the entry below.
 */
const MOCK_BENCHMARKS: Benchmark[] = [
  {
    slug: "aggregator-quote-latency",
    number: "001",
    title: "DEX Aggregator — Quote Latency",
    subtitle:
      "End-to-end response time of swap-quote APIs across the leading DEX aggregators.",
    lastRunAt: ISO("2026-04-28T08:00:00Z"),
    status: "live",
    sampleSize: 12_000,
    metric: "Quote latency",
    unit: "ms",
    category: "Aggregators",
    abstract:
      "We benchmark how long the major DEX-aggregator APIs take to return a usable swap quote for a fixed set of token pairs across Ethereum, Polygon, BNB Chain, Arbitrum and Base. The harness issues identical requests in parallel from three regions (us-east, eu-west, ap-southeast) and records p50, p90 and p99 wall-clock latency along with the success rate. Caches are warmed; failures and 4xx responses are excluded from latency aggregates and counted toward success rate.",
    methodology: [
      "Token-pair set: 40 pairs spanning blue-chips, mid-caps and stable→stable.",
      "Trade size: $1,000 notional per request, normalised against the pair's reference price.",
      "Regions: us-east-1, eu-west-1, ap-southeast-1. Reported figures are the cross-region median.",
      "Cadence: 1 request / pair / region every 30 seconds for 24 hours.",
      "Timeout: 5,000 ms. Responses past the timeout are counted as failures.",
      "Versioning: API endpoints pinned to public docs as of run start; full request/response transcripts stored.",
    ],
    results: [
      {
        name: "Mobula",
        slug: "mobula",
        tag: "Multi-DEX aggregator",
        ms: { p50: 142, p90: 211, p99: 318, mean: 168 },
        successRate: 99.94,
        secondary: { label: "Chains covered", value: "44" },
        highlight: "winner",
      },
      {
        name: "1inch",
        slug: "1inch",
        tag: "Pathfinder v6",
        ms: { p50: 287, p90: 462, p99: 711, mean: 332 },
        successRate: 99.61,
        secondary: { label: "Chains covered", value: "12" },
      },
      {
        name: "0x",
        slug: "0x",
        tag: "Swap API v2",
        ms: { p50: 312, p90: 498, p99: 824, mean: 361 },
        successRate: 99.42,
        secondary: { label: "Chains covered", value: "9" },
      },
      {
        name: "ParaSwap",
        slug: "paraswap",
        tag: "API v6.2",
        ms: { p50: 354, p90: 561, p99: 902, mean: 408 },
        successRate: 99.10,
        secondary: { label: "Chains covered", value: "11" },
      },
      {
        name: "KyberSwap",
        slug: "kyberswap",
        tag: "Aggregator API",
        ms: { p50: 391, p90: 644, p99: 1041, mean: 451 },
        successRate: 98.74,
        secondary: { label: "Chains covered", value: "16" },
      },
      {
        name: "Jupiter",
        slug: "jupiter",
        tag: "Solana only",
        ms: { p50: 166, p90: 248, p99: 372, mean: 188 },
        successRate: 99.81,
        secondary: { label: "Chains covered", value: "1" },
      },
    ],
    findings: [
      "Mobula posts the lowest cross-region p50 of any multi-chain aggregator at 142 ms — roughly half the industry median.",
      "Solana-only Jupiter is the only single-chain provider that comes close on latency; once normalised for chain coverage, Mobula leads every multi-chain peer at every percentile.",
      "Tail latency (p99) is where the spread is widest. Mobula stays under 320 ms; KyberSwap and ParaSwap both cross 900 ms on at least one region.",
      "Success rates are tightly clustered between 98.7% and 99.9%. Differences here are smaller than the latency gap and inside our sampling-noise envelope.",
    ],
    source:
      "https://github.com/mobula/openchainbench/tree/main/harnesses/aggregator-quote",
    extras: {
      series24h: {
        mobula: series(11, 142, 0.12),
        "1inch": series(12, 287, 0.18),
        "0x": series(13, 312, 0.2),
        paraswap: series(14, 354, 0.22),
        kyberswap: series(15, 391, 0.25),
        jupiter: series(16, 166, 0.14),
      },
      regions: {
        mobula: [
          { region: "us-east", p50: 138 },
          { region: "eu-west", p50: 142 },
          { region: "ap-southeast", p50: 151 },
        ],
        "1inch": [
          { region: "us-east", p50: 271 },
          { region: "eu-west", p50: 284 },
          { region: "ap-southeast", p50: 312 },
        ],
        "0x": [
          { region: "us-east", p50: 298 },
          { region: "eu-west", p50: 314 },
          { region: "ap-southeast", p50: 326 },
        ],
        paraswap: [
          { region: "us-east", p50: 339 },
          { region: "eu-west", p50: 352 },
          { region: "ap-southeast", p50: 374 },
        ],
        kyberswap: [
          { region: "us-east", p50: 372 },
          { region: "eu-west", p50: 388 },
          { region: "ap-southeast", p50: 416 },
        ],
        jupiter: [
          { region: "us-east", p50: 156 },
          { region: "eu-west", p50: 168 },
          { region: "ap-southeast", p50: 175 },
        ],
      },
    },
  },

  {
    slug: "bridge-end-to-end-latency",
    number: "002",
    title: "Cross-Chain Bridge — End-to-End Latency",
    subtitle:
      "Time from source-chain confirmation to destination-chain settlement, across the major bridge aggregators.",
    lastRunAt: ISO("2026-04-27T20:00:00Z"),
    status: "live",
    sampleSize: 1_440,
    metric: "End-to-end settlement",
    unit: "s",
    category: "Bridges",
    abstract:
      "We measure the wall-clock time between a user-signed source transaction and credit on the destination chain, through the major bridge aggregators. The harness submits real cross-chain transfers ($25 notional in USDC) on three popular routes (Ethereum→Arbitrum, Arbitrum→Base, Polygon→Optimism) and times them end-to-end. Failure modes (stuck txs, dropped routes, refund flows) are recorded.",
    methodology: [
      "Routes: ETH→ARB, ARB→BASE, POL→OP. Token: USDC (native or canonical).",
      "Trade size: 25 USDC notional. Slippage tolerance fixed at 0.5%.",
      "Cadence: 60 transfers per route per provider over 24 hours, evenly spaced.",
      "Timing: source confirmation → first finalised credit on destination, measured against canonical RPC nodes.",
      "Failures: stuck or refunded transfers count toward success rate. They are excluded from latency aggregates.",
      "Funds: harness wallets are publicly listed; all txs are auditable on-chain.",
    ],
    results: [
      {
        name: "Mobula Bridge",
        slug: "mobula-bridge",
        tag: "Aggregator + intent layer",
        ms: { p50: 18_400, p90: 32_100, p99: 64_800, mean: 24_300 },
        successRate: 99.78,
        secondary: { label: "Routes covered", value: "210" },
        highlight: "winner",
      },
      {
        name: "Across",
        slug: "across",
        tag: "Optimistic relay",
        ms: { p50: 22_800, p90: 41_400, p99: 88_200, mean: 30_900 },
        successRate: 99.41,
        secondary: { label: "Routes covered", value: "78" },
      },
      {
        name: "LiFi",
        slug: "lifi",
        tag: "Aggregator",
        ms: { p50: 31_200, p90: 64_900, p99: 142_300, mean: 44_800 },
        successRate: 98.92,
        secondary: { label: "Routes covered", value: "186" },
      },
      {
        name: "Squid",
        slug: "squid",
        tag: "Axelar-based",
        ms: { p50: 38_500, p90: 71_200, p99: 168_900, mean: 51_400 },
        successRate: 98.61,
        secondary: { label: "Routes covered", value: "64" },
      },
      {
        name: "Socket",
        slug: "socket",
        tag: "Aggregator",
        ms: { p50: 41_800, p90: 82_300, p99: 188_400, mean: 58_700 },
        successRate: 98.20,
        secondary: { label: "Routes covered", value: "152" },
      },
      {
        name: "Stargate",
        slug: "stargate",
        tag: "LayerZero pools",
        ms: { p50: 52_400, p90: 102_800, p99: 221_500, mean: 71_400 },
        successRate: 99.05,
        secondary: { label: "Routes covered", value: "42" },
      },
    ],
    findings: [
      "Mobula's intent-routing is the only aggregator under 20 s p50 across all three routes. Across is the closest competitor on the EVM-only routes we test.",
      "Tail latency dominates user experience. At p99, Mobula settles at 65 s where Socket and Squid exceed 165 s — the difference between 'a refresh' and 'walking away'.",
      "Pure liquidity-pool bridges (Stargate) lag every aggregator on speed but match them on success rate.",
      "Coverage is a separate axis. Mobula leads on count of routes, but a handful of long-tail routes (ZK-rollups → Cosmos) are unsupported by every provider in this set.",
    ],
    source:
      "https://github.com/mobula/openchainbench/tree/main/harnesses/bridge-e2e",
    extras: {
      series24h: {
        "mobula-bridge": series(21, 18400, 0.16),
        across: series(22, 22800, 0.2),
        lifi: series(23, 31200, 0.24),
        squid: series(24, 38500, 0.26),
        socket: series(25, 41800, 0.28),
        stargate: series(26, 52400, 0.18),
      },
      regions: {
        "mobula-bridge": [
          { region: "us-east", p50: 18100 },
          { region: "eu-west", p50: 18400 },
          { region: "ap-southeast", p50: 19200 },
        ],
        across: [
          { region: "us-east", p50: 22300 },
          { region: "eu-west", p50: 22800 },
          { region: "ap-southeast", p50: 23900 },
        ],
        lifi: [
          { region: "us-east", p50: 30800 },
          { region: "eu-west", p50: 31200 },
          { region: "ap-southeast", p50: 32600 },
        ],
        squid: [
          { region: "us-east", p50: 37900 },
          { region: "eu-west", p50: 38500 },
          { region: "ap-southeast", p50: 39800 },
        ],
        socket: [
          { region: "us-east", p50: 41200 },
          { region: "eu-west", p50: 41800 },
          { region: "ap-southeast", p50: 43400 },
        ],
        stargate: [
          { region: "us-east", p50: 51600 },
          { region: "eu-west", p50: 52400 },
          { region: "ap-southeast", p50: 54100 },
        ],
      },
    },
  },

  {
    slug: "price-feed-freshness",
    number: "003",
    title: "Price Feed — Freshness & Coverage",
    subtitle:
      "How stale is the last price? A walk through the major crypto market-data feeds.",
    lastRunAt: ISO("2026-04-28T06:00:00Z"),
    status: "live",
    sampleSize: 86_400,
    metric: "Update latency",
    unit: "ms",
    category: "Data",
    abstract:
      "We measure the time between an on-chain trade settling and the corresponding price update appearing on each commercial market-data feed. The harness watches reference DEX pools on Ethereum, Solana and Base, and continuously polls (or subscribes via websocket where available) each feed for the same token. We report the median delta along with token coverage and uptime.",
    methodology: [
      "Reference: Uniswap v3, Raydium and Aerodrome pools for 60 tokens (top 50 by volume + 10 long-tail).",
      "Capture: a private archive node records each Swap event with millisecond timestamps.",
      "Subscription: websocket where supported, 1-second polling otherwise.",
      "Latency: time between Swap event timestamp and the first feed response that reflects the new price within ±0.05%.",
      "Coverage: a token counts as 'covered' if any feed-side endpoint resolves it within 200 ms.",
      "Window: 24 hours, measured continuously.",
    ],
    results: [
      {
        name: "Mobula API",
        slug: "upstream-api",
        tag: "WS + REST",
        ms: { p50: 410, p90: 980, p99: 2_100, mean: 612 },
        successRate: 99.92,
        secondary: { label: "Tokens covered", value: "2.1M" },
        highlight: "winner",
      },
      {
        name: "CoinGecko Pro",
        slug: "coingecko",
        tag: "REST only",
        ms: { p50: 13_400, p90: 21_800, p99: 41_200, mean: 16_800 },
        successRate: 99.74,
        secondary: { label: "Tokens covered", value: "16.4k" },
      },
      {
        name: "CoinMarketCap Pro",
        slug: "cmc",
        tag: "REST",
        ms: { p50: 18_600, p90: 28_900, p99: 52_400, mean: 22_400 },
        successRate: 99.66,
        secondary: { label: "Tokens covered", value: "11.2k" },
      },
      {
        name: "DefiLlama",
        slug: "defillama",
        tag: "REST",
        ms: { p50: 22_300, p90: 38_400, p99: 71_800, mean: 28_400 },
        successRate: 99.81,
        secondary: { label: "Tokens covered", value: "9.8k" },
      },
      {
        name: "GeckoTerminal",
        slug: "geckoterminal",
        tag: "REST",
        ms: { p50: 4_200, p90: 9_100, p99: 18_400, mean: 5_900 },
        successRate: 99.58,
        secondary: { label: "Tokens covered", value: "3.4M" },
      },
    ],
    findings: [
      "Mobula's websocket feed is the only commercial source that reflects on-chain trades sub-second on average. The next-fastest peer (GeckoTerminal) trails by ~10x at p50.",
      "Polling-only feeds (CoinGecko, CMC, DefiLlama) cluster between 13–22 s p50. That gap reflects an architectural choice — minute-bar caches — not a bug.",
      "GeckoTerminal leads on raw token coverage by count, with Mobula a close second; on long-tail tokens (Solana memes, fresh launches), Mobula resolves more requests below 200 ms.",
      "Uptime is uniformly excellent across the field; freshness — not availability — is what separates the providers.",
    ],
    source:
      "https://github.com/mobula/openchainbench/tree/main/harnesses/feed-freshness",
    extras: {
      series24h: {
        "upstream-api": series(31, 410, 0.18),
        coingecko: series(32, 13400, 0.14),
        cmc: series(33, 18600, 0.12),
        defillama: series(34, 22300, 0.16),
        geckoterminal: series(35, 4200, 0.22),
      },
      regions: {
        "upstream-api": [
          { region: "us-east", p50: 396 },
          { region: "eu-west", p50: 410 },
          { region: "ap-southeast", p50: 442 },
        ],
        coingecko: [
          { region: "us-east", p50: 13100 },
          { region: "eu-west", p50: 13400 },
          { region: "ap-southeast", p50: 14200 },
        ],
        cmc: [
          { region: "us-east", p50: 18100 },
          { region: "eu-west", p50: 18600 },
          { region: "ap-southeast", p50: 19400 },
        ],
        defillama: [
          { region: "us-east", p50: 21800 },
          { region: "eu-west", p50: 22300 },
          { region: "ap-southeast", p50: 23200 },
        ],
        geckoterminal: [
          { region: "us-east", p50: 4100 },
          { region: "eu-west", p50: 4200 },
          { region: "ap-southeast", p50: 4500 },
        ],
      },
    },
  },

  {
    slug: "rpc-head-lag",
    number: "004",
    title: "RPC Head Lag — How Far Behind the Tip?",
    subtitle:
      "How quickly each RPC provider reports new blocks, measured against a private archive node tracking the canonical tip.",
    lastRunAt: ISO("2026-04-28T07:30:00Z"),
    status: "live",
    sampleSize: 172_800,
    metric: "Head lag",
    unit: "ms",
    category: "RPCs",
    abstract:
      "We measure the gap between the canonical chain tip and the head reported by each commercial RPC endpoint. The harness runs a fleet of private archive nodes (Ethereum, Base, Arbitrum, Polygon, Optimism), records every new block, then polls each RPC's `eth_blockNumber` every 250 ms and timestamps when the same block first becomes visible. Head lag is the wall-clock delta between the two. Reads that fail or return stale results past the timeout count as failures.",
    methodology: [
      "Chains: Ethereum, Base, Arbitrum, Polygon, Optimism. Cross-chain median is the headline.",
      "Reference: a private archive node per chain, peered to multiple sources, validated against block hash.",
      "Cadence: `eth_blockNumber` every 250 ms per provider per region for 24 hours.",
      "Regions: us-east-1, eu-west-1, ap-southeast-1. Cross-region median reported.",
      "Timeout: 2,000 ms. Stale reads past the timeout are excluded from latency aggregates and counted in success rate.",
      "Privacy: harness wallets are public; raw block-by-block timestamps are stored for audit.",
    ],
    results: [
      {
        name: "Mobula RPC",
        slug: "mobula-rpc",
        tag: "Multi-chain edge",
        ms: { p50: 78, p90: 124, p99: 218, mean: 96 },
        successRate: 99.97,
        secondary: { label: "Chains", value: "44" },
        highlight: "winner",
      },
      {
        name: "Alchemy",
        slug: "alchemy",
        tag: "Supernode",
        ms: { p50: 124, p90: 184, p99: 312, mean: 148 },
        successRate: 99.92,
        secondary: { label: "Chains", value: "9" },
      },
      {
        name: "QuickNode",
        slug: "quicknode",
        tag: "Premium",
        ms: { p50: 142, p90: 218, p99: 388, mean: 174 },
        successRate: 99.86,
        secondary: { label: "Chains", value: "26" },
      },
      {
        name: "Infura",
        slug: "infura",
        tag: "Mainnet only",
        ms: { p50: 178, p90: 264, p99: 432, mean: 212 },
        successRate: 99.81,
        secondary: { label: "Chains", value: "8" },
      },
      {
        name: "Ankr",
        slug: "ankr",
        tag: "Public+premium",
        ms: { p50: 312, p90: 482, p99: 824, mean: 386 },
        successRate: 99.42,
        secondary: { label: "Chains", value: "32" },
      },
      {
        name: "Tenderly",
        slug: "tenderly",
        tag: "Web3 gateway",
        ms: { p50: 438, p90: 624, p99: 942, mean: 510 },
        successRate: 99.18,
        secondary: { label: "Chains", value: "12" },
      },
      {
        name: "Public RPC",
        slug: "public-rpc",
        tag: "Free, rate-limited",
        ms: { p50: 1_180, p90: 2_410, p99: 5_820, mean: 1_640 },
        successRate: 96.74,
        secondary: { label: "Chains", value: "n/a" },
      },
    ],
    findings: [
      "Mobula's edge layer is the only commercial RPC under 100 ms head lag at p50 across all five chains in the test set.",
      "The premium tier (Alchemy, QuickNode, Infura) clusters tightly between 120 and 180 ms — close enough that ranking inside the cluster shifts week to week with regional load.",
      "At p99 the spread blows out: Public RPC tail-lags by nearly 6 seconds. This is what users feel during congestion, when reading a stale block can mean a duplicate transaction.",
      "Success rate tracks lag — providers that lag more also drop or 5xx more often. The two metrics are not independent.",
    ],
    source:
      "https://github.com/mobula/openchainbench/tree/main/harnesses/rpc-head-lag",
    extras: {
      series24h: {
        "mobula-rpc": series(41, 78, 0.16),
        alchemy: series(42, 124, 0.18),
        quicknode: series(43, 142, 0.2),
        infura: series(44, 178, 0.2),
        ankr: series(45, 312, 0.24),
        tenderly: series(46, 438, 0.22),
        "public-rpc": series(47, 1_180, 0.32),
      },
      regions: {
        "mobula-rpc": [
          { region: "us-east", p50: 74 },
          { region: "eu-west", p50: 78 },
          { region: "ap-southeast", p50: 86 },
        ],
        alchemy: [
          { region: "us-east", p50: 118 },
          { region: "eu-west", p50: 124 },
          { region: "ap-southeast", p50: 138 },
        ],
        quicknode: [
          { region: "us-east", p50: 134 },
          { region: "eu-west", p50: 142 },
          { region: "ap-southeast", p50: 158 },
        ],
        infura: [
          { region: "us-east", p50: 168 },
          { region: "eu-west", p50: 178 },
          { region: "ap-southeast", p50: 196 },
        ],
        ankr: [
          { region: "us-east", p50: 298 },
          { region: "eu-west", p50: 312 },
          { region: "ap-southeast", p50: 348 },
        ],
        tenderly: [
          { region: "us-east", p50: 422 },
          { region: "eu-west", p50: 438 },
          { region: "ap-southeast", p50: 478 },
        ],
        "public-rpc": [
          { region: "us-east", p50: 1_120 },
          { region: "eu-west", p50: 1_180 },
          { region: "ap-southeast", p50: 1_340 },
        ],
      },
    },
  },
];

/**
 * Async loader: returns the live benchmarks (Prometheus + spec overlay) or
 * mocks if Prometheus is unreachable. React `cache()` dedupes calls inside
 * a single request so each page renders consistently.
 */
import { cache } from "react";
import { overlayLive } from "@/lib/spec";

export const getBenchmarks = cache(async (): Promise<Benchmark[]> => {
  const overlaid = await Promise.all(MOCK_BENCHMARKS.map(overlayLive));
  return overlaid;
});

export async function getBenchmark(slug: string): Promise<Benchmark | undefined> {
  const all = await getBenchmarks();
  return all.find((b) => b.slug === slug);
}

export async function getBenchmarksByCategory(): Promise<
  Array<[Benchmark["category"], Benchmark[]]>
> {
  const all = await getBenchmarks();
  const map = new Map<Benchmark["category"], Benchmark[]>();
  for (const b of all) {
    const list = map.get(b.category) ?? [];
    list.push(b);
    map.set(b.category, list);
  }
  return Array.from(map.entries());
}

/** Synchronous slug list for `generateStaticParams` — drawn from mocks so
 * the route table is stable even when Prometheus is offline. */
export function getBenchmarkSlugs(): string[] {
  return MOCK_BENCHMARKS.map((b) => b.slug);
}

export function formatLastRun(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}
