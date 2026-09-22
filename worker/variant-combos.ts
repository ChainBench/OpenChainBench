import { defaultTier } from "@/lib/materialize/load";
import type { BenchmarkFilters } from "@/lib/materialize/load";
import type { Spec } from "@/lib/spec-schema";

/**
 * Every dimension combination the worker builds a variant for.
 *
 * Pure, and in its own module on purpose: the app never builds a filtered
 * view on demand (loadBenchmarkFiltered reads the worker's blob, then
 * Redis, then gives up and the variant route falls back to the aggregate),
 * so a dimension missing here is not a missing tab, it is a tab showing
 * unfiltered numbers under a filtered label. That deserves a test, and a
 * test should not have to boot the worker to get at it.
 */
export function variantCombos(spec: Spec): BenchmarkFilters[] {
  const dims = spec.dimensions ?? {};
  const chains = (dims.chain ?? []).map((d) => d.value).filter((v) => v !== "all");
  const regions = (dims.region ?? []).map((d) => d.value).filter((v) => v !== "all");
  const kinds = (dims.kind ?? []).map((d) => d.value).filter((v) => v !== "all");
  const venues = (dims.venue ?? []).map((d) => d.value).filter((v) => v !== "all");
  const amounts = (dims.amount_usd ?? []).map((d) => d.value);
  // Trade-size buckets, crossed with the rest: a reader who picks Solana and
  // "Under $25" needs that exact combination to exist, or the page falls back
  // to the aggregate and labels it as the slice.
  const buckets = (dims.bucket ?? []).map((d) => d.value).filter((v) => v !== "all");
  // Access tiers: the headline tier IS the aggregate (sig "" is built
  // with it pinned), so only the other cohorts get their own variants,
  // crossed with every label dimension like any other filter.
  const headlineTier = defaultTier(spec);
  const tiers = (dims.tier ?? []).map((d) => d.value).filter((v) => v !== headlineTier);
  const opt = <T,>(xs: T[]): (T | undefined)[] => (xs.length ? [undefined, ...xs] : [undefined]);
  const combos: BenchmarkFilters[] = [];
  for (const chain of opt(chains)) {
    for (const region of opt(regions)) {
      for (const kind of opt(kinds)) {
        for (const venue of opt(venues)) {
          for (const amount_usd of opt(amounts)) {
            for (const bucket of opt(buckets)) {
              for (const tier of opt(tiers)) {
                if (!chain && !region && !kind && !venue && !amount_usd && !bucket && !tier) continue; // the aggregate is tier A
                combos.push({
                  ...(chain ? { chain } : {}),
                  ...(region ? { region } : {}),
                  ...(kind ? { kind } : {}),
                  ...(venue ? { venue } : {}),
                  ...(amount_usd ? { amount_usd } : {}),
                  ...(bucket ? { bucket } : {}),
                  ...(tier ? { tier } : {}),
                });
              }
            }
          }
        }
      }
    }
  }
  return combos;
}
