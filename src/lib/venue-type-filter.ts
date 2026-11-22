import type { Benchmark, ProviderVenueType } from "@/types/benchmark";

export type VenueTypeView = "all" | ProviderVenueType;

export const VENUE_TYPE_PARAM = "venue_type";

type Typed = { venueType?: ProviderVenueType };

type VenueTypeCounts = { all: number; dex: number; cex: number };

export function parseVenueTypeView(raw: string | null): VenueTypeView {
  return raw === "dex" || raw === "cex" ? raw : "all";
}

export function venueTypeCounts(results: readonly Typed[]): VenueTypeCounts {
  let dex = 0;
  let cex = 0;
  for (const r of results) {
    if (r.venueType === "dex") dex++;
    else if (r.venueType === "cex") cex++;
  }
  return { all: results.length, dex, cex };
}

export function filterByVenueType<T extends Typed>(
  results: readonly T[],
  view: VenueTypeView,
): T[] {
  if (view === "all") return [...results];
  return results.filter((r) => r.venueType === view);
}

export function scopeToVenueType(
  bench: Benchmark | undefined,
  view: VenueTypeView = "all",
): Benchmark | undefined {
  if (!bench || view === "all") return bench;
  return { ...bench, results: filterByVenueType(bench.results, view) };
}
