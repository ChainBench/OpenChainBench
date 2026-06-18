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
    const alternatives = await loadAllAlternatives();
    const checks = await Promise.all(
      alternatives.map(async (alt) => {
        // Skip the alternatives page that targets this exact product so we
        // never link a provider back at its own page (e.g. /products/lifi
        // pointing at /alternatives/lifi).
        const altTargetSlug = alt.target_product.toLowerCase().replace(/\s+/g, "-");
        if (altTargetSlug === me) return null;
        const bench = await loadBenchmark(alt.benchmark, { chain: alt.chain });
        if (!bench) return null;
        // Match by canonical slug so aliases (helius-sender -> helius,
        // eth-usd -> ethereum, ...) light up the corresponding product
        // page. Without this, `helius` would never find itself in the
        // sender-bench leaderboard.
        const featured = bench.results.some((r) => {
          if (r.ms.p50 <= 0) return false;
          return canonicalize(r.slug).slug.toLowerCase() === me;
        });
        if (!featured) return null;
        return { slug: alt.slug, targetProduct: alt.target_product };
      }),
    );
    const features = checks.filter((x): x is AlternativeFeature => x !== null);
    features.sort((a, b) => a.targetProduct.localeCompare(b.targetProduct));
    return features.slice(0, ALTERNATIVES_CAP);
  },
);
