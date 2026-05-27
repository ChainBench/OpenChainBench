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
import { getBenchmarks } from "@/data/benchmarks";
import { liveResults } from "@/lib/provider-filters";
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
};

function titleCaseSlug(s: string): string {
  return s
    .split(/[-_]/)
    .map((w) => (w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Resolves a slug to its canonical (slug, display name) pair. */
function canonicalize(slug: string): { slug: string; name: string } {
  const lc = slug.toLowerCase();
  const canon = PRODUCT_ALIASES[lc] ?? lc;
  return { slug: canon, name: CANONICAL_NAMES[canon] ?? titleCaseSlug(canon) };
}

export type ProviderAppearance = {
  benchmark: Pick<Benchmark, "slug" | "title" | "subtitle" | "category" | "metric" | "unit" | "higherIsBetter" | "status" | "lastRunAt">;
  result: ProviderResult;
  rank: number;
  totalRanked: number;
};

export type ProviderProfile = {
  slug: string;
  name: string;
  type?: ProviderResult["type"];
  appearances: ProviderAppearance[];
  /** Count of benchmarks where this provider ranks #1. */
  wins: number;
  /** Categories the provider appears in. used for the index page filter. */
  categories: Benchmark["category"][];
};

function rankProviders(b: Benchmark): ProviderResult[] {
  const live = liveResults(b.results);
  return [...live].sort((a, c) =>
    b.higherIsBetter ? c.ms.p50 - a.ms.p50 : a.ms.p50 - c.ms.p50,
  );
}

export const getProviders = cache(async (): Promise<ProviderProfile[]> => {
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

    b.results.forEach((r) => {
      const canon = canonicalize(r.slug);
      const key = canon.slug;
      const existing = byKey.get(key);
      // Ranking is per-bench, so look up the rank by the result's own
      // slug (the bench knows it under its original name), not the
      // canonical key.
      const idx = rankBySlug.get(r.slug.toLowerCase());
      const isRanked = idx !== undefined;
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
        },
        result: r,
        rank: isRanked ? (idx as number) + 1 : 0,
        totalRanked: total,
      };
      if (existing) {
        existing.appearances.push(appearance);
        if (!existing.categories.includes(b.category)) {
          existing.categories.push(b.category);
        }
        if (isRanked && idx === 0) existing.wins += 1;
        if (!existing.type && r.type) existing.type = r.type;
      } else {
        byKey.set(key, {
          slug: canon.slug,
          name: canon.name,
          type: r.type,
          appearances: [appearance],
          wins: isRanked && idx === 0 ? 1 : 0,
          categories: [b.category],
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
});

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
