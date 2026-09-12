import type { ProviderResult } from "@/types/benchmark";

/**
 * Field-level summary stats for a benchmark's provider list.
 * Pure function - used by the bench detail page and the alternative
 * landing pages, which both render the same summary strip above the
 * chart.
 */
export function computeFieldStats(results: ProviderResult[]): {
  fieldMin: number;
  fieldMedian: number;
  fieldMax: number;
  tailMin: number;
  tailMax: number;
  tailSpread: number;
} {
  // Drop "currently unavailable" providers from every aggregate. Their
  // placeholder values are 0 and would otherwise drag the Best stat to
  // 0 ms, the Spread tailMin to 0 (which kills the ratio), and the
  // Median toward the lower half of the field.
  // Also drop all-zero rows: the load path promotes a provider with
  // companion-panel data but no headline value to "live" with p50=0
  // (a token-less venue on a valuation bench), and the ledger already
  // prunes such rows, so the strip must not report Best = 0 for a
  // provider the table does not rank. Signed benches keep negative
  // rows because the check is "not all zero", not "> 0".
  const live = results.filter(
    (r) =>
      r.availability !== "unavailable" &&
      (r.ms.p50 !== 0 || r.ms.p90 !== 0 || r.ms.p99 !== 0),
  );
  const p50s = live.map((r) => r.ms.p50);
  const p99s = live.map((r) => r.ms.p99);

  const fieldMin = p50s.length ? Math.min(...p50s) : 0;
  const fieldMax = p50s.length ? Math.max(...p50s) : 0;
  const fieldMedian = p50s.length
    ? [...p50s].sort((a, b) => a - b)[Math.floor(p50s.length / 2)]
    : 0;

  const tailMin = p99s.length ? Math.min(...p99s) : 0;
  const tailMax = p99s.length ? Math.max(...p99s) : 0;
  const tailSpread = tailMin > 0 ? tailMax / tailMin : 0;

  return { fieldMin, fieldMedian, fieldMax, tailMin, tailMax, tailSpread };
}
