/**
 * Helpers for the "related providers" section on /products/[slug].
 *
 * Two surfaces:
 *  1. Compare candidates. Walks the compare graph (provider to provider
 *     shared-bench mapping) and returns the providers that share at least
 *     one bench with the current product, sorted by shared-bench count.
 *     Each entry carries the canonical pair slug so the section can link
 *     directly to /compare/<a>-vs-<b>.
 *  2. Alternatives features. Walks every alternatives YAML, loads its
 *     parent bench, and returns the alternatives pages where this product
 *     appears in the leaderboard with non-zero data. No manual list, the
 *     page lights up automatically whenever a new alternatives YAML or a
 *     new bench result lands.
 *
 * Both helpers are wrapped with React's `cache()` so two callers on the
 * same render reuse the same provider / alternatives lookup.
 */

import { cache } from "react";
import { unstable_cache } from "next/cache";
import { canonicalize, getProviders } from "@/lib/providers";
import { canonicalPairSlug } from "@/lib/compare-pairing-shared";
import { loadAllAlternatives } from "@/lib/alternatives";
import { loadBenchmark } from "@/lib/spec";

export type CompareCandidate = {
  /** Canonical product slug (matches /products/<slug>). */
  slug: string;
  /** Display name carried over from the provider profile. */
  name: string;
  /** Number of benchmarks both providers share. */
  sharedCount: number;
  /** Canonical /compare URL slug for the head to head pair. */
  pairSlug: string;
};

export type AlternativeFeature = {
  /** Slug of the alternatives YAML (the /alternatives/<slug> URL). */
  slug: string;
  /** Display name of the alternatives page target product. */
  targetProduct: string;
};

/** Hard cap on how many compare candidates we render. */
const COMPARE_CAP = 12;

/** Hard cap on how many alternatives lists we render. */
const ALTERNATIVES_CAP = 8;

/**
 * Zombie slugs from pre-PR #647 pm-api-latency, when each aggregator was
 * split per venue (codex-kalshi, codex-polymarket, predexon-*). The bench
 * now collapses everything into the parent provider slug (codex,
 * predexon) but the materialize worker's per-slug Redis blobs survive
 * for the TTL window after each schema change, and old slugs leak into
 * compare candidates / alternatives links until they expire. Filtering
 * here keeps the UI clean across the eventual-consistency gap.
 */
const DEAD_COMPOSITE_SLUGS = new Set([
  "codex-kalshi",
  "codex-polymarket",
  "predexon-kalshi",
  "predexon-limitless",
  "predexon-polymarket",
]);

/**
 * Returns the providers that share at least one live benchmark with the
 * given product, sorted by shared-bench count descending then by name.
 * Capped at the top {@link COMPARE_CAP} entries.
 *
 * Every shared count is computed from the same `getProviders()` source
 * the rest of the site uses, so a new bench or a new provider lights up
 * here without a code change.
 */
export const getCompareCandidates = cache(async function getCompareCandidates(
  providerSlug: string,
): Promise<CompareCandidate[]> {
  const profiles = await getProviders();
  const me = providerSlug.toLowerCase();
  const meProfile = profiles.find((p) => p.slug.toLowerCase() === me);
  if (!meProfile) return [];
  const myBenches = new Set(meProfile.appearances.map((a) => a.benchmark.slug));
  if (myBenches.size === 0) return [];

  const out: CompareCandidate[] = [];
  for (const other of profiles) {
    if (other.slug.toLowerCase() === me) continue;
    if (DEAD_COMPOSITE_SLUGS.has(other.slug.toLowerCase())) continue;
    let shared = 0;
    for (const a of other.appearances) {
      if (myBenches.has(a.benchmark.slug)) shared += 1;
    }
    if (shared === 0) continue;
    out.push({
      slug: other.slug,
      name: other.name,
      sharedCount: shared,
      pairSlug: canonicalPairSlug(meProfile.slug, other.slug),
    });
  }

  out.sort((a, b) => {
    if (a.sharedCount !== b.sharedCount) return b.sharedCount - a.sharedCount;
    return a.name.localeCompare(b.name);
  });
  return out.slice(0, COMPARE_CAP);
});

/**
 * Reverse map from provider canonical slug to the list of alternatives
 * pages where that provider is featured. Built once per cache window by
 * walking every alternatives YAML, loading its parent bench, and
 * collecting the featured providers per page.
 *
 * Wrapped with `unstable_cache` so the 26 alternatives YAML walks +
 * loadBenchmark calls run at most once per 60 s window. The previous
 * shape re-ran the full walk on every product page render, which on a
 * cold lambda was 10 to 14 s and the visible "products page is slow"
 * symptom.
 */
async function buildAlternativesReverseMap(): Promise<
  Map<string, AlternativeFeature[]>
> {
  const alternatives = await loadAllAlternatives();
  // Defensive: only ever emit /alternatives/<slug> for a slug we
  // actually have a live YAML for. loadAllAlternatives() already
  // filters to status=live, so today this is equivalent to the
  // alternatives array, but the explicit Set makes the invariant
  // local and survives any future refactor where alt-like records
  // start flowing in from a different source (bench metadata,
  // materialize worker, ...).
  const liveSlugs = new Set(alternatives.map((a) => a.slug));
  const benches = await Promise.all(
    alternatives.map((alt) =>
      loadBenchmark(alt.benchmark, { chain: alt.chain }).then((bench) => ({
        alt,
        bench,
      })),
    ),
  );
  const map = new Map<string, AlternativeFeature[]>();
  for (const { alt, bench } of benches) {
    if (!bench) continue;
    if (!liveSlugs.has(alt.slug)) continue;
    const altTargetSlug = alt.target_product
      .toLowerCase()
      .replace(/\s+/g, "-");
    const seen = new Set<string>();
    for (const r of bench.results) {
      if (r.ms.p50 <= 0) continue;
      const canon = canonicalize(r.slug).slug.toLowerCase();
      if (canon === altTargetSlug) continue;
      if (DEAD_COMPOSITE_SLUGS.has(canon)) continue;
      if (seen.has(canon)) continue;
      seen.add(canon);
      const list = map.get(canon) ?? [];
      list.push({ slug: alt.slug, targetProduct: alt.target_product });
      map.set(canon, list);
    }
  }
  return map;
}

/** Cross-request cache. Tags with `benchmarks` so any bench update via
 *  `revalidateTag('benchmarks')` rebuilds the map. */
const buildAlternativesReverseMapCached = unstable_cache(
  async (): Promise<Array<[string, AlternativeFeature[]]>> => {
    const map = await buildAlternativesReverseMap();
    return Array.from(map.entries());
  },
  ["alternatives-reverse-map-v1"],
  { revalidate: 60, tags: ["benchmarks"] },
);

/**
 * Returns the alternatives pages whose underlying benchmark features
 * the given provider with non-zero p50 data. Capped at the top
 * {@link ALTERNATIVES_CAP} entries by alternatives target name.
 *
 * Provider membership is inferred from the bench's `results[]` array,
 * not declared in the alternatives YAML, so adding a new alternatives
 * file or a new provider to an existing bench auto-includes them here.
 */
export const getAlternativesFeaturing = cache(
  async function getAlternativesFeaturing(
    providerSlug: string,
  ): Promise<AlternativeFeature[]> {
    const me = providerSlug.toLowerCase();
    const entries = await buildAlternativesReverseMapCached();
    const features = entries.find(([slug]) => slug === me)?.[1] ?? [];
    const sorted = [...features].sort((a, b) =>
      a.targetProduct.localeCompare(b.targetProduct),
    );
    return sorted.slice(0, ALTERNATIVES_CAP);
  },
);
