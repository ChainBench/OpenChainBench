import type { BenchPayload, RangeId } from "./types";

/**
 * Fetch the per-provider series for a bench + range. Hits the same OCB
 * route the public API exposes (`/api/series/[slug]`) so the modal sees
 * the same data any external caller would.
 */
export async function fetchBenchSeries(
  slug: string,
  range: RangeId,
): Promise<BenchPayload> {
  const res = await fetch(`/api/series/${encodeURIComponent(slug)}?range=${range}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/api/series failed (${res.status}): ${text || res.statusText}`);
  }
  return res.json();
}
