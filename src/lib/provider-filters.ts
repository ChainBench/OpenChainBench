import type { ProviderResult } from "@/types/benchmark";

/**
 * Field of providers the leaderboard treats as "live this cycle".
 *
 * Two conditions both need to hold:
 *   - `availability !== "unavailable"` — the spec loader marks providers
 *     with no Prom data this cycle as unavailable so the augmented zero
 *     entries don't poison the ranking.
 *   - `ms.p50 > 0` — defensive fallback for legacy entries (or chart-
 *     specific zero placeholders) that slipped through without the
 *     availability flag.
 *
 * Centralised so the rule lives in one place instead of being copied
 * across every chart component, the stats helpers, and the spec
 * placeholder renderer. Update here when the definition of "live"
 * changes (e.g. add a min sample-size threshold).
 */
export function liveResults(results: ProviderResult[]): ProviderResult[] {
  return results.filter(
    (r) => r.availability !== "unavailable" && r.ms.p50 > 0,
  );
}
