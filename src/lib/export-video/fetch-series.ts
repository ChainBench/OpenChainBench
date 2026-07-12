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

/** What /api/series actually emits: dense values with `null` for empty
 *  Prom buckets. The external Remotion renderer consumes plain number
 *  arrays (BenchPayload contract), so nulls are bridged before hand-off. */
type WireBenchPayload = Omit<BenchPayload, "providers"> & {
  providers: (Omit<BenchPayload["providers"][number], "values"> & {
    values: (number | null)[];
  })[];
};

/** Bridge null buckets for the video renderer: linear interpolation
 *  between the nearest real neighbors, and leading / trailing nulls
 *  clamped to the nearest real value. Honest enough for an animated
 *  race (the race reads trajectory, not per-bucket truth) and keeps the
 *  renderer's numbers-only contract intact. Returns [] when the series
 *  has no real sample at all. */
export function bridgeGaps(values: (number | null)[]): number[] {
  const firstIdx = values.findIndex((v) => v != null);
  if (firstIdx === -1) return [];
  const out = new Array<number>(values.length);
  let prevIdx = -1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prevIdx === -1) {
      // Clamp leading nulls to the first real value.
      for (let j = 0; j <= i; j++) out[j] = v;
    } else {
      const prev = out[prevIdx];
      const span = i - prevIdx;
      for (let j = prevIdx + 1; j <= i; j++) {
        out[j] = prev + ((v - prev) * (j - prevIdx)) / span;
      }
    }
    prevIdx = i;
  }
  // Clamp trailing nulls to the last real value.
  for (let j = prevIdx + 1; j < values.length; j++) out[j] = out[prevIdx];
  return out;
}

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
  const wire: WireBenchPayload = await res.json();
  return {
    ...wire,
    providers: wire.providers.map((p) => ({
      ...p,
      values: bridgeGaps(p.values),
    })),
  };
}
