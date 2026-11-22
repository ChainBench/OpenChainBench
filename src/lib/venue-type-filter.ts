import type { Benchmark, ProviderVenueType } from "@/types/benchmark";

export type VenueTypeView = "all" | ProviderVenueType;

export const VENUE_TYPE_PARAM = "venue_type";

type Typed = { venueType?: ProviderVenueType };

type VenueTypeCounts = { all: number; dex: number; cex: number };

export function venueTypeQuery(venueType?: ProviderVenueType): string {
  return venueType ? `?${VENUE_TYPE_PARAM}=${venueType}` : "";
}

export function scopeNote(
  chain?: string,
  venueType?: ProviderVenueType,
): string {
  const parts = [
    chain ? `filtered to ${chain}` : "",
    venueType ? `${venueType.toUpperCase()} venues only` : "",
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

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

export function shownVenueTypeView(
  picked: VenueTypeView,
  counts: VenueTypeCounts,
): VenueTypeView {
  return counts.dex + counts.cex > 0 ? picked : "all";
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
  const results = filterByVenueType(bench.results, view);
  const sampleSize = results.reduce((n, r) => n + (r.sampleSize ?? 0), 0);
  return { ...bench, results, sampleSize };
}
