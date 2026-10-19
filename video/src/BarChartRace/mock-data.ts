/**
 * Mock data shaped like a real OpenChainBench bench. The bench-data video
 * generator works against `BenchPayload`; these fixtures let us iterate
 * on motion design without the live OCB API.
 *
 * Shape definitions now live in `src/types/bench.ts` — re-exported here
 * for backwards-compat with the older import paths.
 */

import type { BenchPayload, ProviderSeries } from "../types/bench";
export type { BenchPayload, ProviderSeries };

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-06-04T00:00:00Z");

// 30 daily buckets, oldest -> newest
const timestamps = Array.from({ length: 30 }, (_, i) => NOW - (29 - i) * DAY_MS);

/**
 * Synthetic latency series for 8 onchain data providers. Values are in
 * milliseconds (lower = better). Trajectories are hand-tuned to produce
 * a visually interesting race: Mobula climbs from 4th to 1st, GeckoTerminal
 * dethroned around day 18, a couple of long flat lines for contrast.
 */
function trajectory(base: number, slope: number, jitter: number, len = 30) {
  const out: number[] = [];
  let seed = base * 0.6180339887;
  for (let i = 0; i < len; i++) {
    seed = (seed * 9301 + 49297) % 233280; // deterministic PRNG
    const noise = (seed / 233280 - 0.5) * 2 * jitter;
    out.push(Math.max(10, base + slope * i + noise));
  }
  return out;
}

export const MOCK_BENCH: BenchPayload = {
  slug: "fastest-onchain-data-api",
  title: "Fastest onchain data API",
  metric: "Head-lag p50 (lower is faster)",
  unit: "ms",
  higherIsBetter: false,
  timestamps,
  providers: [
    {
      slug: "mobula",
      name: "Mobula",
      color: "#FF6B35",
      logo: "logos/mobula.svg",
      values: trajectory(820, -22, 80),
    },
    {
      slug: "codex",
      name: "Codex",
      color: "#84CC16",
      logo: "logos/codex.svg",
      values: trajectory(620, -3, 60),
    },
    {
      slug: "geckoterminal",
      name: "GeckoTerminal",
      color: "#8B5CF6",
      logo: "logos/geckoterminal.png",
      values: trajectory(540, 8, 70),
    },
    {
      slug: "helius",
      name: "Helius",
      color: "#FF4D8D",
      logo: "logos/helius.svg",
      values: trajectory(720, -5, 90),
    },
    {
      slug: "moralis",
      name: "Moralis",
      color: "#5B89FF",
      logo: "logos/moralis.png",
      values: trajectory(980, -2, 110),
    },
    {
      slug: "birdeye",
      name: "Birdeye",
      color: "#F0B90B",
      logo: "logos/birdeye.png",
      values: trajectory(1180, -1, 100),
    },
    {
      slug: "bitquery",
      name: "Bitquery",
      color: "#22D3EE",
      logo: "logos/bitquery.png",
      values: trajectory(1340, 1, 130),
    },
    {
      slug: "dune",
      name: "Dune",
      color: "#FB923C",
      logo: "logos/dune.svg",
      values: trajectory(1520, -3, 120),
    },
  ],
};

/**
 * Higher-is-better mock for the views where "more is better" reads
 * naturally (donut market share, count podium for coverage benches).
 * Latency is lower-is-better so reusing MOCK_BENCH on these views would
 * read backwards visually — the smallest latency would get the largest
 * slice, which is technically correct but optically broken.
 */
export const MOCK_BENCH_COUNT: BenchPayload = {
  slug: "onchain-data-most-networks",
  title: "Onchain data API with most networks supported",
  metric: "Mainnets supported (live count)",
  unit: "count",
  higherIsBetter: true,
  timestamps,
  providers: [
    {
      slug: "coingecko",
      name: "CoinGecko",
      color: "#8DC647",
      logo: "logos/coingecko.webp",
      values: trajectory(280, 1, 5),
    },
    {
      slug: "geckoterminal",
      name: "GeckoTerminal",
      color: "#8B5CF6",
      logo: "logos/geckoterminal.png",
      values: trajectory(240, 0.5, 4),
    },
    {
      slug: "moralis",
      name: "Moralis",
      color: "#5B89FF",
      logo: "logos/moralis.png",
      values: trajectory(145, 0.3, 3),
    },
    {
      slug: "codex",
      name: "Codex",
      color: "#84CC16",
      logo: "logos/codex.svg",
      values: trajectory(118, 0.5, 3),
    },
    {
      slug: "mobula",
      name: "Mobula",
      color: "#FF6B35",
      logo: "logos/mobula.svg",
      values: trajectory(76, 0.2, 2),
    },
    {
      slug: "dune",
      name: "Dune",
      color: "#FB923C",
      logo: "logos/dune.svg",
      values: trajectory(60, 0.1, 2),
    },
    {
      slug: "bitquery",
      name: "Bitquery",
      color: "#22D3EE",
      logo: "logos/bitquery.png",
      values: trajectory(40, 0, 1),
    },
  ],
};
