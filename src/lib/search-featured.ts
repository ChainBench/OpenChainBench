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
import { readMaterialized } from "@/lib/materialize/store";
import { loadSnapshotFromBlob } from "@/lib/bench-blob";
import { leader, fieldValue } from "@/lib/citation";

const FEATURED_BENCH_SLUGS = [
  "pm-ws-latency",
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

// FEATURED_SLUGS previously re-exported ALL_SLUGS but had zero
// external consumers. ALL_SLUGS stays used internally by
// buildFeaturedLeaders below.

/**
 * Worker-safe variant of `buildFeaturedLeaders`. Reads each of the 12
 * featured/trending bench blobs directly from KV via `readMaterialized`
 * instead of going through `getBenchmarks()`, which sits behind Next's
 * `unstable_cache` + React `cache()` and throws
 * `Invariant: incrementalCache missing` when invoked outside a
 * Next request lifecycle (i.e. from the standalone worker tsx process).
 *
 * Same output shape as `buildFeaturedLeaders` — both write through the
 * same `writeCohortSnapshot("search-featured", ...)` envelope.
 */
export async function buildFeaturedLeadersFromStore(): Promise<FeaturedLeadersBlob> {
  const snapshots = await Promise.all(
    ALL_SLUGS.map(async (slug) => {
      try {
        // Try CDN blob first (Phase 3), fall back to Redis via SRH.
        const snap =
          (await loadSnapshotFromBlob(slug, "")) ??
          (await readMaterialized(slug, ""));
        return snap ? snap.bench : null;
      } catch {
        return null;
      }
    }),
  );
  const bySlug = new Map(
    snapshots
      .filter((b): b is NonNullable<typeof b> => b !== null)
      .map((b) => [b.slug, b]),
  );

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
