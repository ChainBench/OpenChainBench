/**
 * Provider aggregator. Walks every loaded benchmark, collects each
 * provider's appearances and their result on that bench, and ranks them.
 *
 * Output is what powers /providers/[slug] and the embeddable badge API.
 * No YAML files are read here. providers are inferred from the live
 * benchmark catalogue, so the page set stays in sync with whatever the
 * harnesses are emitting.
 */

import { cache } from "react";
import { unstable_cache } from "next/cache";
import { getBenchmarks } from "@/data/benchmarks";
import { liveResults } from "@/lib/provider-filters";
import { readBestPerChain } from "@/lib/per-chain-contract";
import type { Benchmark, ProviderResult } from "@/types/benchmark";

/**
 * Slug consolidation for /products. When the same brand or asset appears
 * under multiple slugs across benches (e.g. helius vs helius-sender,
 * ethereum vs eth-usd oracle pair, avalanche vs avalanche-official RPC),
 * we collapse their appearances into one canonical entry so the products
 * leaderboard reads cleanly.
 *
 * Mirrors the logo-manifest ALIASES set, plus the registry `parent` field
 * on sub-products. Kept inline here (not derived from the registry) so the
 * aggregator never has to read the registry at build time.
 */
const PRODUCT_ALIASES: Record<string, string> = {
  // Sub-products → parent brand
  "helius-sender": "helius",
  "publicnode-feehistory": "publicnode",
  // Chain official RPC → chain brand
  "arbitrum-official": "arbitrum",
  "avalanche-official": "avalanche",
  "base-official": "base",
  "optimism-official": "optimism",
  // Oracle pair → underlying chain / asset
  "eth-usd": "ethereum",
  "sol-usd": "solana",
  "bnb-usd": "bnb",
  "avax-usd": "avalanche",
  "btc-usd": "bitcoin",
  "xrp-usd": "xrp",
  "ada-usd": "cardano",
  "doge-usd": "dogecoin",
  "link-usd": "chainlink",
  "matic-usd": "polygon",
};

/**
 * Display name for a canonical slug when the canonical itself has no own
 * bench appearance (e.g. bitcoin shows up only via the BTC/USD oracle
 * pair). Falls back to title-case of the slug for anything not listed.
 */
const CANONICAL_NAMES: Record<string, string> = {
  bitcoin: "Bitcoin",
  ethereum: "Ethereum",
  solana: "Solana",
  bnb: "BNB",
  avalanche: "Avalanche",
  xrp: "XRP",
  cardano: "Cardano",
  dogecoin: "Dogecoin",
  chainlink: "Chainlink",
  polygon: "Polygon",
  helius: "Helius",
  publicnode: "PublicNode",
  arbitrum: "Arbitrum",
  base: "Base",
  optimism: "Optimism",
  // NFT bench 040 providers — explicit brand casing.
  opensea: "OpenSea",
  // Other brand casings frequently referenced.
  geckoterminal: "GeckoTerminal",
  coinpaprika: "CoinPaprika",
  coingecko: "CoinGecko",
  coinstats: "CoinStats",
};

function titleCaseSlug(s: string): string {
  return s
    .split(/[-_]/)
    .map((w) => (w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Resolves a slug to its canonical (slug, display name) pair. */
export function canonicalize(slug: string): { slug: string; name: string } {
  const lc = slug.toLowerCase();
  const canon = PRODUCT_ALIASES[lc] ?? lc;
  return { slug: canon, name: CANONICAL_NAMES[canon] ?? titleCaseSlug(canon) };
}

export type ProviderAppearance = {
  benchmark: Pick<
    Benchmark,
    | "slug"
    | "title"
    | "subtitle"
    | "category"
    | "metric"
    | "unit"
    | "higherIsBetter"
    | "status"
    | "lastRunAt"
  > & {
    /** Chain dimension values from the spec, when present. Stored on the
     *  appearance so /products/[slug] can render chain-aware chips without
     *  re-loading the full benchmark. Mirrors `benchmark.dimensions.chain`. */
    chainDimensions?: { value: string; label: string }[];
    /** Per-chain leader stash for the bench, when computed by spec.ts.
     *  Same shape as `Benchmark.bestPerChain` — included here so consumers
     *  can compute per-chain rank for this provider without a full bench
     *  re-fetch. */
    bestPerChain?: Record<string, ProviderResult>;
    /** Region dimension values from the spec, when present. Mirrors
     *  `benchmark.dimensions.region`. */
    regionDimensions?: { value: string; label: string }[];
    /** Exact per-cell rankings from the bench's `rank_matrix_query`
     *  (key = `<chain>|<region>`, "all" for an undeclared dimension or a
     *  derived marginal). When present this is the authoritative source
     *  for scoped leadership claims — per-chain ranks built from
     *  cross-region averages hide region-restricted leaders. */
    cellRanks?: Benchmark["cellRanks"];
  };
  result: ProviderResult;
  rank: number;
  totalRanked: number;
  /** Per-chain rank for this provider on this bench. Only populated when
   *  the bench declares chain dimensions AND bestPerChain has at least one
   *  entry. Key = chain slug (matching dimensions.chain[].value), value =
   *  { rank, totalRanked } computed within the providers present on that
   *  chain. Renderers can fall back to `rank` when this is empty. */
  rankPerChain?: Record<string, { rank: number; totalRanked: number }>;
};

export type ProviderProfile = {
  slug: string;
  name: string;
  type?: ProviderResult["type"];
  appearances: ProviderAppearance[];
  /** Total count of #1 finishes credited to this provider. Counting rule:
   *  - For benches WITHOUT chain dimensions: 1 win per aggregate #1.
   *  - For benches WITH chain dimensions: 1 win per chain led (so a
   *    Solana-only provider that leads on Solana earns +1 per such bench
   *    rather than free credits from biased cross-chain aggregates). See
   *    the inline rule comment in getProviders() for the rationale. */
  wins: number;
  /** Categories the provider appears in. used for the index page filter. */
  categories: Benchmark["category"][];
  /** Aggregate per-chain leadership across all benches. Key = chain slug,
   *  value = number of benches the provider leads on that chain. Empty
   *  record when the provider hasn't led on any chain. Useful for sort
   *  /filter ("show all #1 on Solana") on the products index. */
  chainWins?: Record<string, number>;
};

function rankProviders(b: Benchmark): ProviderResult[] {
  const live = liveResults(b.results);
  return [...live].sort((a, c) =>
    b.higherIsBetter ? c.ms.p50 - a.ms.p50 : a.ms.p50 - c.ms.p50,
  );
}

/**
 * Compute per-chain rank for every provider on a bench. Bench must declare
 * `dimensions.chain` and have a non-empty `bestPerChain` for any rank to be
 * recorded.
 *
 * Approximation: spec.ts only stashes the *leader* per chain (one extra Prom
 * roundtrip per chain). To express other providers' rank-per-chain, we use a
 * coarse fallback: anyone present in the unfiltered `results` is ranked by
 * the bench's standard direction (lower-is-better or higher-is-better)
 * within the live result set, and the leader's slot is forcibly overridden
 * with rank 1 for that chain. This is a soft signal — the bench page chain
 * tabs are authoritative — but it is enough to flag chain-restricted
 * providers like GMGN as "#1 on Solana only" on /products/[slug].
 */
function rankPerChainForBench(
  b: Benchmark,
): Record<string, Map<string, { rank: number; totalRanked: number }>> {
  const out: Record<string, Map<string, { rank: number; totalRanked: number }>> = {};
  const bestPerChain = readBestPerChain(b);
  if (!bestPerChain || !b.dimensions?.chain) return out;
  const liveSorted = rankProviders(b);
  if (liveSorted.length === 0) return out;
  // Set of provider slugs that returned data per chain, populated by
  // spec.ts. When present, we restrict per-chain ranks to that set so
  // a Solana-only provider doesn't get a phantom chip on Base/BNB.
  // Falls back to "everyone on the aggregate list" only when the bench
  // hasn't stashed this — e.g. older cached entries from a v3 deploy.
  const providersPerChain = (b as { providersPerChain?: Record<string, string[]> })
    .providersPerChain;
  for (const chain of b.dimensions.chain) {
    if (chain.value === "all") continue;
    const leader = bestPerChain[chain.value];
    if (!leader) continue;
    const presentSet = providersPerChain?.[chain.value]
      ? new Set(providersPerChain[chain.value].map((s) => s.toLowerCase()))
      : undefined;
    const scoped = presentSet
      ? liveSorted.filter((r) => presentSet.has(r.slug.toLowerCase()))
      : liveSorted;
    const perProvider = new Map<string, { rank: number; totalRanked: number }>();
    const leaderLc = leader.slug.toLowerCase();
    const leaderIdx = scoped.findIndex((r) => r.slug.toLowerCase() === leaderLc);
    scoped.forEach((r, idx) => {
      const lc = r.slug.toLowerCase();
      if (lc === leaderLc) {
        perProvider.set(lc, { rank: 1, totalRanked: scoped.length });
        return;
      }
      // Anyone ranked above the leader in the unfiltered set drops by one
      // slot here (since the leader skips ahead of them on this chain).
      const rankOnChain =
        leaderIdx !== -1 && idx < leaderIdx ? idx + 2 : idx + 1;
      perProvider.set(lc, { rank: rankOnChain, totalRanked: scoped.length });
    });
    out[chain.value] = perProvider;
  }
  return out;
}

async function buildProviders(): Promise<ProviderProfile[]> {
  const benches = await getBenchmarks();
  const byKey = new Map<string, ProviderProfile>();

  for (const b of benches) {
    // Walk every result in the spec (live or draft). For live benches we
    // also rank them so the first-place provider gets a +1 win. For
    // drafts we still register the provider so the /providers index
    // doesn't disappear when an upstream harness is temporarily down
    // (which would otherwise hide ~80% of products locally).
    const ranked = b.status === "live" ? rankProviders(b) : [];
    const rankBySlug = new Map<string, number>();
    ranked.forEach((r, idx) => rankBySlug.set(r.slug.toLowerCase(), idx));
    const total = ranked.length;

    // Per-chain ranks (soft signal — see rankPerChainForBench notes).
    // Empty record when the bench has no chain dimensions or no
    // bestPerChain data this cycle.
    const perChainRanks = b.status === "live" ? rankPerChainForBench(b) : {};
    const benchBestPerChain = readBestPerChain(b);
    const hasChainDimensions =
      (b.dimensions?.chain?.filter((c) => c.value !== "all").length ?? 0) > 0;

    b.results.forEach((r) => {
      const canon = canonicalize(r.slug);
      const key = canon.slug;
      const existing = byKey.get(key);
      // Ranking is per-bench, so look up the rank by the result's own
      // slug (the bench knows it under its original name), not the
      // canonical key.
      const idx = rankBySlug.get(r.slug.toLowerCase());
      const isRanked = idx !== undefined;
      // Collect per-chain rank for this provider on this bench (if any).
      const rankPerChain: Record<string, { rank: number; totalRanked: number }> = {};
      for (const [chain, perProvider] of Object.entries(perChainRanks)) {
        const entry = perProvider.get(r.slug.toLowerCase());
        if (entry) rankPerChain[chain] = entry;
      }
      const hasPerChain = Object.keys(rankPerChain).length > 0;

      // Wins rule (documented):
      //   - A "win" credit is one #1 finish.
      //   - When the bench declares NO chain dimensions, a provider earns
      //     +1 win iff they are #1 on the unfiltered aggregate. Pre-existing
      //     semantics, untouched.
      //   - When the bench DOES declare chain dimensions, the unfiltered
      //     aggregate is chain-mix biased (a Solana-only provider can
      //     mechanically beat the field). We don't credit a win for the
      //     aggregate #1 here. Instead, we credit +1 win for EACH chain
      //     this provider leads on (per bestPerChain). This makes the
      //     wins count reflect real chain-scoped #1 finishes, not biased
      //     cross-chain rolling totals.
      let winsEarned = 0;
      if (hasChainDimensions) {
        for (const entry of Object.values(rankPerChain)) {
          if (entry.rank === 1) winsEarned += 1;
        }
      } else if (isRanked && idx === 0) {
        winsEarned = 1;
      }

      const appearance: ProviderAppearance = {
        benchmark: {
          slug: b.slug,
          title: b.title,
          subtitle: b.subtitle,
          category: b.category,
          metric: b.metric,
          unit: b.unit,
          higherIsBetter: b.higherIsBetter,
          status: b.status,
          lastRunAt: b.lastRunAt,
          chainDimensions: b.dimensions?.chain,
          bestPerChain: benchBestPerChain,
          regionDimensions: b.dimensions?.region,
          cellRanks: b.cellRanks,
        },
        result: r,
        rank: isRanked ? (idx as number) + 1 : 0,
        totalRanked: total,
        ...(hasPerChain ? { rankPerChain } : {}),
      };
      // Collect chain-leadership tally so the profile can surface
      // "Solana leader on 3 benches" etc.
      const chainsLed: string[] = [];
      for (const [chain, entry] of Object.entries(rankPerChain)) {
        if (entry.rank === 1) chainsLed.push(chain);
      }

      if (existing) {
        existing.appearances.push(appearance);
        if (!existing.categories.includes(b.category)) {
          existing.categories.push(b.category);
        }
        existing.wins += winsEarned;
        if (!existing.type && r.type) existing.type = r.type;
        if (chainsLed.length > 0) {
          existing.chainWins = existing.chainWins ?? {};
          for (const c of chainsLed) {
            existing.chainWins[c] = (existing.chainWins[c] ?? 0) + 1;
          }
        }
      } else {
        byKey.set(key, {
          slug: canon.slug,
          name: canon.name,
          type: r.type,
          appearances: [appearance],
          wins: winsEarned,
          categories: [b.category],
          ...(chainsLed.length > 0
            ? {
                chainWins: Object.fromEntries(
                  chainsLed.map((c) => [c, 1] as const),
                ),
              }
            : {}),
        });
      }
    });
  }

  const profiles = Array.from(byKey.values());
  profiles.sort((a, b) => {
    if (a.wins !== b.wins) return b.wins - a.wins;
    if (a.appearances.length !== b.appearances.length) {
      return b.appearances.length - a.appearances.length;
    }
    return a.name.localeCompare(b.name);
  });
  return profiles;
}

/** Cross-request cache. The expensive part isn't `getBenchmarks()`
 *  itself (already wrapped in unstable_cache) but the per-provider
 *  ranking + wins + per-chain aggregation post-processing on top. A 60
 *  s revalidate aligns with the bench level ISR window and the standard
 *  `benchmarks` tag so any `revalidateTag('benchmarks')` clears this
 *  along with the rest of the data layer. */
const buildProvidersCached = unstable_cache(
  buildProviders,
  ["providers-v1"],
  { revalidate: 60, tags: ["benchmarks"] },
);

export const getProviders = cache(
  async (): Promise<ProviderProfile[]> => buildProvidersCached(),
);

export async function getProviderSlugs(): Promise<string[]> {
  const profiles = await getProviders();
  return profiles.map((p) => p.slug);
}

export async function getProvider(slug: string): Promise<ProviderProfile | undefined> {
  const profiles = await getProviders();
  // Aliased URLs (e.g. /products/helius-sender, /products/btc-usd) resolve
  // to the canonical profile so backward-compat links keep working.
  const canon = canonicalize(slug).slug;
  return profiles.find((p) => p.slug.toLowerCase() === canon);
}
