import type { ProviderResult } from "@/types/benchmark";

/**
 * Field-level summary stats for a benchmark's provider list.
 * Pure function — used by the bench detail page and the alternative
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
  const p50s = results.map((r) => r.ms.p50);
  const p99s = results.map((r) => r.ms.p99);

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
