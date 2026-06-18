/**
 * Sort comparator for provider results by p50.
 * - latency / cost benches (lower is better) → ascending: best first
 * - coverage / count benches (higher is better) → descending: best first
 *
 * In both cases the "best" provider is at index 0 of the sorted array.
 *
 * Generic shape constraint: only `ms.p50` is required so the helper
 * works against the full ProviderResult AND looser projections used
 * by upstream callers (e.g. the badge route's per-cell rank input).
 */
export function rankResults<T extends { ms: { p50: number } }>(
  results: T[],
  higherIsBetter: boolean,
): T[] {
  return [...results].sort((a, b) =>
    higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
  );
}
