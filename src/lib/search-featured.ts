/**
 * Featured + Trending leaders surfaced in the header search dialog.
 *
 * Built once per cron tick by `/api/cron/warm-search-featured`, persisted
 * as a single small JSON blob in Upstash KV under
 * `ocb:cohort:search-featured:v1`, and served by `/api/search/featured`
 * with aggressive edge cache. Total payload ~2 KB for 12 cards — orders of
 * magnitude smaller than the full `/api/citable` response the search
 * dialog used to call on every open.
 *
 * Slugs match the hardcoded lists in `src/components/search/search-dialog.tsx`.
 * If a slug here doesn't resolve to a live benchmark, it's silently dropped:
 * the dialog tolerates a short list and falls back to skeleton rows.
 */

import { getBenchmarks } from "@/data/benchmarks";
import { leader, fieldValue } from "@/lib/citation";

const FEATURED_BENCH_SLUGS = [
  "pm-data-freshness",
  "aggregator-head-lag",
  "l1-finality",
  "rpc-capabilities",
  "perp-fees",
  "bridge-quote-latency",
];

const TRENDING_BENCH_SLUGS = [
  "stablecoin-peg-usdt-anchored",
  "metadata-coverage",
  "validator-yield",
  "network-fees",
  "perp-funding",
  "solana-tx-landing",
];

export type FeaturedCardData = {
  slug: string;
  title: string;
  category: string;
  unit: string;
  value: number | null;
  leader: { name: string; slug: string } | null;
};

export type FeaturedLeadersBlob = {
  featured: FeaturedCardData[];
  trending: FeaturedCardData[];
};

const ALL_SLUGS = [...FEATURED_BENCH_SLUGS, ...TRENDING_BENCH_SLUGS];

/**
 * Build the slim featured-leaders payload from the current benchmark set.
 * Reads through whatever caching `getBenchmarks` provides (unstable_cache
 * + materialize KV snapshots). The cron calls this every minute and writes
 * the result to its own dedicated KV blob; the public endpoint just reads
 * that blob.
 */
export async function buildFeaturedLeaders(): Promise<FeaturedLeadersBlob> {
  const all = await getBenchmarks();
  const bySlug = new Map(all.map((b) => [b.slug, b]));

  const card = (slug: string): FeaturedCardData | null => {
    const b = bySlug.get(slug);
    if (!b) return null;
    const top = leader(b);
    return {
      slug: b.slug,
      title: b.title,
      category: b.category,
      unit: b.unit,
      value: fieldValue(b),
      leader: top ? { name: top.name, slug: top.slug } : null,
    };
  };

  return {
    featured: FEATURED_BENCH_SLUGS.map(card).filter(
      (x): x is FeaturedCardData => x !== null,
    ),
    trending: TRENDING_BENCH_SLUGS.map(card).filter(
      (x): x is FeaturedCardData => x !== null,
    ),
  };
}

/** Exported for the public endpoint + the dialog's TS type. */
export const FEATURED_SLUGS = ALL_SLUGS;
