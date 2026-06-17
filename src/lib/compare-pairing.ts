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
 * roughly 100 providers today, fast enough at build time). The shape
 * is intentionally light so the JSON payload shipped to the client
 * stays small.
 */

import { cache } from "react";
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

export const buildCompareGraph = cache(async function buildCompareGraph(): Promise<CompareGraph> {
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
});

