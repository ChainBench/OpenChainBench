import type { BenchPayload, RangeId } from "./types";

/**
 * Fetch the per-provider series for a bench + range. Hits the same OCB
 * route the public API exposes (`/api/series/[slug]`) so the modal sees
 * the same data any external caller would.
 *
 * `chain` / `region` mirror the bench page's URL filters — for benches
 * whose series only have data per-chain (network-fees, etc.) the global
 * view returns empty arrays, so the modal must pass these through.
 */
export async function fetchBenchSeries(
  slug: string,
  range: RangeId,
  filters: { chain?: string | null; region?: string | null } = {},
): Promise<BenchPayload> {
  const qs = new URLSearchParams({ range });
  if (filters.chain) qs.set("chain", filters.chain);
  if (filters.region) qs.set("region", filters.region);
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
