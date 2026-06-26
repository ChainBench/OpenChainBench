/**
 * Category taxonomy for benchmark hubs.
 *
 * Mirrors the closed `Category` enum from `spec-schema.ts` (the source
 * of truth that every YAML spec gets validated against). Centralised
 * here so the `/benchmarks/category/<cat>` routes, the sitemap, the
 * client filter and the meta-builders all share one slug ↔ label ↔
 * description vocabulary. If a new category is added to the schema,
 * adding it here is the only other touch-point needed to surface a
 * dedicated hub URL.
 *
 * Slugs are lowercase, kebab-case, ASCII-only so they survive URL
 * canonicalisation, RSS readers and JSON-LD @id fragments without
 * needing encoding. Labels match the schema enum verbatim so the
 * client filter can compare `b.category === entry.label` without an
 * extra lookup.
 *
 * Descriptions are SEO copy that explains the category scope. They
 * land in <meta description>, OG description, and the H1 sub-paragraph
 * on the category hub page, so each must read as a standalone sentence
 * (a) without the surrounding template and (b) with the category name
 * substituted in. No em / en dashes per the project copy rules.
 */

export type Category =
  | "Aggregators"
  | "Bridges"
  | "Blockchains"
  | "Trading"
  | "Wallets"
  | "RPCs"
  | "NFT APIs";

export type CategoryEntry = {
  /** URL slug. Lowercase, kebab-case, ASCII. */
  slug: string;
  /** Schema enum label, matches `Benchmark.category` exactly. */
  label: Category;
  /** Plural human heading used in H1 + breadcrumb. */
  heading: string;
  /** SEO copy under the H1 + <meta description>. */
  description: string;
};

export const CATEGORIES: readonly CategoryEntry[] = [
  {
    slug: "aggregators",
    label: "Aggregators",
    heading: "Aggregator benchmarks",
    description:
      "Live OpenChainBench measurements for crypto data aggregators. Compare quote latency, market coverage, and freshness across the providers that fan out queries to multiple underlying sources.",
  },
  {
    slug: "bridges",
    label: "Bridges",
    heading: "Bridge benchmarks",
    description:
      "Open, reproducible benchmarks for cross-chain bridges and intent layers. Compare quote latency, end-to-end fees, and route coverage across the bridges that move value between chains.",
  },
  {
    slug: "blockchains",
    label: "Blockchains",
    heading: "Blockchain benchmarks",
    description:
      "Network-level measurements that compare blockchains head to head. Time to finality, block time, gas estimation accuracy, and validator economics on every L1 and L2 OpenChainBench tracks.",
  },
  {
    slug: "trading",
    label: "Trading",
    heading: "Trading benchmarks",
    description:
      "Latency, fee, and freshness benchmarks for trading venues and execution providers. Perpetuals, spot DEX quotes, oracle deviation, and Polymarket data freshness measured continuously.",
  },
  {
    slug: "wallets",
    label: "Wallets",
    heading: "Wallet benchmarks",
    description:
      "Benchmarks that compare wallet infrastructure providers on label coverage, address resolution, and the data layers that power production wallet UIs.",
  },
  {
    slug: "rpcs",
    label: "RPCs",
    heading: "RPC benchmarks",
    description:
      "Live OpenChainBench measurements for RPC and node providers. Compare capability coverage, transaction landing latency, and reliability across the endpoints that power production dApps.",
  },
  {
    slug: "nft-apis",
    label: "NFT APIs",
    heading: "NFT API benchmarks",
    description:
      "Benchmarks that compare NFT data API providers on collection metadata coverage, freshness, and the indexing depth that production NFT marketplaces and wallets depend on.",
  },
];

export const CATEGORY_BY_SLUG: ReadonlyMap<string, CategoryEntry> = new Map(
  CATEGORIES.map((c) => [c.slug, c]),
);

export const CATEGORY_SLUG_BY_LABEL: ReadonlyMap<Category, string> = new Map(
  CATEGORIES.map((c) => [c.label, c.slug]),
);

/** Slug used in the `/benchmarks/category/<slug>` URL for a given
 *  `Benchmark.category` value. Returns `null` for unknown labels so
 *  call sites can degrade to the unscoped hub instead of a 404 link. */
export function categorySlugFromLabel(label: string): string | null {
  return CATEGORY_SLUG_BY_LABEL.get(label as Category) ?? null;
}
