import type { Benchmark, ProviderVenueType } from "@/types/benchmark";

export type VenueTypeView = "all" | ProviderVenueType;

export const VENUE_TYPE_PARAM = "venue_type";

type VenueTyped = { venueType?: ProviderVenueType };

type VenueTypeCounts = Record<VenueTypeView, number>;

export function venueTypeQuery(venueType?: ProviderVenueType): string {
  return venueType ? `?${VENUE_TYPE_PARAM}=${venueType}` : "";
}

export function venueScopeLabel(view: VenueTypeView = "all"): string {
  return view === "all" ? "" : `${view.toUpperCase()} venues only`;
}

export function scopeNote(chain?: string, view?: VenueTypeView): string {
  const parts = [
    chain ? `filtered to ${chain}` : "",
    venueScopeLabel(view),
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

export function parseVenueTypeView(raw: string | null): VenueTypeView {
  return raw === "dex" || raw === "cex" ? raw : "all";
}

export function venueTypeCounts(results: readonly VenueTyped[]): VenueTypeCounts {
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

export function filterByVenueType<T extends VenueTyped>(
  results: readonly T[],
  view: VenueTypeView,
): T[] {
  if (view === "all") return [...results];
  return results.filter((r) => r.venueType === view);
}

export function scopeFromParams(
  bench: Benchmark,
  params: URLSearchParams,
): { view: VenueTypeView; bench: Benchmark } {
  const view = parseVenueTypeView(params.get(VENUE_TYPE_PARAM));
  return { view, bench: scopeToVenueType(bench, view) ?? bench };
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
