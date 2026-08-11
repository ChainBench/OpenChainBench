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

/**
 * Minimum success rate (0-100) for a row to appear in the ranked
 * display surfaces (ledger table, bar chart, per-chain comparison).
 * Prometheus gauges retain their last value when the harness fails,
 * so a chain that once measured <1 s but has been dead for 24 h
 * still holds a non-zero p50 while its success rate collapses to 0 %.
 * The all-zero filter in liveResults does not catch this case; this
 * floor does. Kept deliberately low (5 %) so occasionally-flaky rows
 * are still shown, while completely dead ones (0 %, 0.28 %) are
 * excluded from the ranking. citation.ts uses a separate 50 % floor
 * for the citable leader claim; display and citation thresholds are
 * intentionally decoupled.
 */
export const MIN_DISPLAY_SUCCESS_PCT = 5;

/** liveResults filtered by the display success floor. Use for ranked
 *  surfaces (ledger, bar chart, per-chain pages). Do NOT use in the
 *  citation path — citation.ts applies its own 50 % floor separately. */
export function displayResults(results: ProviderResult[]): ProviderResult[] {
  return liveResults(results).filter(
    (r) => (r.successRate ?? 100) >= MIN_DISPLAY_SUCCESS_PCT,
  );
}
