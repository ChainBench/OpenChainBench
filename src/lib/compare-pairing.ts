/**
 * Build the data the /compare hub selector needs to suggest valid
 * head to head pairs:
 *
 *   providers: a slim list of every provider that runs in at least one
 *              live bench, with slug + name + optional chain tag.
 *   shared:    map from each provider slug to the slugs of providers
 *              that share at least one bench with it. Used by the
 *              client side selector to filter the second dropdown so
 *              the user can only pick a comparable second provider.
 *
 * Heavy work is upfront on the server (O(N^2) over the provider list,
 * roughly 100 providers today). `getProviders()` loads every provider
 * profile with full appearance lists, which is the actual bottleneck
 * on a cold render of the /compare hub.
 *
 * The result is the same for every visitor between deploys and barely
 * changes between revalidation windows, so it is wrapped in
 * `unstable_cache` with a 5 minute revalidate and the standard
 * `benchmarks` tag for cross-request cross-instance reuse. The inner
 * `cache()` is kept as well so multiple component subtrees in the same
 * render still dedupe.
 */

import { cache } from "react";
import { unstable_cache } from "next/cache";
import { getProviders } from "@/lib/providers";
import type { CompareCandidate } from "@/lib/compare-pairing-shared";

export type { CompareCandidate };
export { canonicalPairSlug } from "@/lib/compare-pairing-shared";

export type CompareGraph = {
  providers: CompareCandidate[];
  /** providerSlug to array of providerSlugs that share at least one
   *  bench. Sorted by slug for deterministic output. */
  shared: Record<string, string[]>;
};

async function buildCompareGraphRaw(): Promise<CompareGraph> {
  const profiles = await getProviders();
  const benchSetByProvider = new Map<string, Set<string>>();
  for (const p of profiles) {
    benchSetByProvider.set(
      p.slug,
      new Set(p.appearances.map((a) => a.benchmark.slug)),
    );
  }
  const shared: Record<string, string[]> = {};
  for (const p of profiles) {
    const set = benchSetByProvider.get(p.slug);
    if (!set || set.size === 0) {
      shared[p.slug] = [];
      continue;
    }
    const compatible: string[] = [];
    for (const other of profiles) {
      if (other.slug === p.slug) continue;
      const otherSet = benchSetByProvider.get(other.slug);
      if (!otherSet) continue;
      let hit = false;
      for (const slug of set) {
        if (otherSet.has(slug)) {
          hit = true;
          break;
        }
      }
      if (hit) compatible.push(other.slug);
    }
    compatible.sort();
    shared[p.slug] = compatible;
  }
  const providers: CompareCandidate[] = profiles
    .map((p) => ({ slug: p.slug, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { providers, shared };
}

/** Cross-request cache. Bump the key when the CompareGraph shape
 *  changes so deploys carrying a new field don't deserialize old
 *  entries. The 5 minute revalidate is well above the provider profile
 *  ISR window (60 s) yet still under the bench rolling window so any
 *  new provider or appearance flows in within minutes of being live. */
const buildCompareGraphCached = unstable_cache(
  buildCompareGraphRaw,
  ["compare-graph-v1"],
  { revalidate: 300, tags: ["benchmarks"] },
);

export const buildCompareGraph = cache(
  async function buildCompareGraph(): Promise<CompareGraph> {
    return buildCompareGraphCached();
  },
);

