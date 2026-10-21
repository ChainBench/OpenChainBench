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
  tier?: string | null;
  /** Metric panel id — when set, returns series for that companion metric. */
  panel?: string | null;
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

/** Window where at least half the providers report: [start, end], or null
 *  when no bucket qualifies. A bench that began mid-range (or a daily
 *  series whose first rollup lands 19 days in) otherwise opens the video
 *  on a flat line copied back from the first real reading, which reads as
 *  stale data for days. */
export function coverageWindow(series: (number | null)[][]): [number, number] | null {
  const steps = Math.max(0, ...series.map((v) => v.length));
  const need = Math.max(1, Math.ceil(series.length / 2));
  const ok = (i: number) => series.filter((v) => v[i] != null).length >= need;
  let start = 0;
  while (start < steps && !ok(start)) start++;
  if (start === steps) return null;
  let end = steps - 1;
  while (end > start && !ok(end)) end--;
  return [start, end];
}

export async function fetchBenchSeries(
  slug: string,
  range: RangeId,
  filters: SeriesFilters = {},
): Promise<BenchPayload> {
  const qs = new URLSearchParams({ range });
  for (const dim of ["chain", "region", "kind", "venue", "tier"] as const) {
    const v = filters[dim];
    if (v && v !== "all") qs.set(dim, v);
  }
  if (filters.panel) qs.set("panel", filters.panel);
  const res = await fetch(
    `/api/series/${encodeURIComponent(slug)}?${qs.toString()}`,
    { cache: "no-store" },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/api/series failed (${res.status}): ${text || res.statusText}`);
  }
  const wire: WireBenchPayload = await res.json();
  const win = coverageWindow(wire.providers.map((p) => p.values));
  // Keep at least two buckets: a race needs a start and an end.
  const [a, b] = win && win[1] > win[0] ? win : [0, wire.timestamps.length - 1];
  return {
    ...wire,
    timestamps: wire.timestamps.slice(a, b + 1),
    providers: wire.providers
      .map((p) => ({ ...p, values: bridgeGaps(p.values.slice(a, b + 1)) }))
      .filter((p) => p.values.length > 0),
  };
}
