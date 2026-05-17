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
import type { Benchmark, ProviderResult } from "@/types/benchmark";

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
  const live = b.results.filter((r) => r.ms.p50 > 0);
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
      const key = r.slug.toLowerCase();
      const existing = byKey.get(key);
      const idx = rankBySlug.get(key);
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
          slug: r.slug,
          name: r.name,
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
  return profiles.find((p) => p.slug.toLowerCase() === slug.toLowerCase());
}
