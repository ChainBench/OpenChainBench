import type { Benchmark, ProviderResult } from "@/types/benchmark";

/**
 * Sort comparator for provider results by p50.
 * - latency / cost benches (lower is better) → ascending: best first
 * - coverage / count benches (higher is better) → descending: best first
 *
 * In both cases the "best" provider is at index 0 of the sorted array.
 */
export function rankResults<T extends Pick<ProviderResult, "ms">>(
  results: T[],
  higherIsBetter: boolean,
): T[] {
  return [...results].sort((a, b) =>
    higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
  );
}

/** Pick the leader of a benchmark. fastest / cheapest / most. */
export function leader(b: Benchmark): ProviderResult | undefined {
  return rankResults(b.results, b.higherIsBetter)[0];
}
