import type { BenchPayload, RangeId } from "./types";

/**
 * Fetch the per-provider series for a bench + range. Hits the same OCB
 * route the public API exposes (`/api/series/[slug]`) so the modal sees
 * the same data any external caller would.
 *
 * `chain` / `region` / `kind` / `venue` mirror the bench page's dimension
 * filters — for benches whose series only have data per-chain
 * (network-fees, etc.) the global view returns empty arrays, so the
 * modal must pass these through. "all" means no filter and is dropped
 * client-side to keep cache keys canonical.
 */
export type SeriesFilters = {
  chain?: string | null;
  region?: string | null;
  kind?: string | null;
  venue?: string | null;
};

export async function fetchBenchSeries(
  slug: string,
  range: RangeId,
  filters: SeriesFilters = {},
): Promise<BenchPayload> {
  const qs = new URLSearchParams({ range });
  for (const dim of ["chain", "region", "kind", "venue"] as const) {
    const v = filters[dim];
    if (v && v !== "all") qs.set(dim, v);
  }
  const res = await fetch(
    `/api/series/${encodeURIComponent(slug)}?${qs.toString()}`,
    { cache: "no-store" },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/api/series failed (${res.status}): ${text || res.statusText}`);
  }
  return res.json();
}
