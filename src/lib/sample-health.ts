/**
 * Sample-health classification.
 *
 * Bench pages used to rank providers from sample counts spanning 3 to
 * tens of thousands without surfacing the confidence level, while the
 * methodology page advertised "n >= 1000 per provider". On low cadence
 * benches like perp-funding (3 series per venue by design) the methodology
 * line read as broken, an E-E-A-T penalty waiting to happen.
 *
 * A flat threshold would mis-classify legitimately low-cadence benches.
 * Per-bench `expected_n` declared in the YAML lets each bench publish
 * what "full coverage" looks like, and this module computes
 * health = sampleSize / expectedN per provider:
 *
 *   - healthy      health >= 0.5
 *   - low          0.1 <= health < 0.5
 *   - insufficient health < 0.1
 *
 * Renderers gate UI accordingly: hide insufficient rows from rankings,
 * show low rows with a "Low sample" pill, healthy rows render normally.
 *
 * Citation surfaces (/api/citable, /api/stat, headline sentences) read
 * the bench-level aggregate so a benchmark with mostly-insufficient
 * providers does not assert a winner in machine-readable feeds.
 */

import type { ProviderResult } from "@/types/benchmark";

/** Inclusive ratio at and above which a provider is treated as healthy. */
export const HEALTHY_THRESHOLD = 0.5;
/** Inclusive ratio at and above which a provider is treated as low. */
export const LOW_THRESHOLD = 0.1;

export type DataConfidence = "healthy" | "low" | "insufficient";

/** Classify a single provider's sample health against the bench-declared
 *  expected sample count. Returns undefined when the bench did not declare
 *  expected_n (legacy display behavior, no badge) or when the provider's
 *  sample count is missing. */
export function classifyHealth(
  sampleSize: number | undefined,
  expectedN: number | undefined,
): { confidence: DataConfidence; ratio: number } | undefined {
  if (!expectedN || expectedN <= 0) return undefined;
  if (sampleSize == null || !Number.isFinite(sampleSize)) return undefined;
  const ratio = sampleSize / expectedN;
  let confidence: DataConfidence;
  if (ratio < LOW_THRESHOLD) confidence = "insufficient";
  else if (ratio < HEALTHY_THRESHOLD) confidence = "low";
  else confidence = "healthy";
  return { confidence, ratio };
}

/**
 * Aggregate confidence across a provider set, used at the bench level
 * (citable JSON, headline sentence, structured data). The aggregate is
 * the classification of the median per-provider ratio so a single
 * low-cadence outlier does not poison the verdict for an otherwise
 * healthy field. Returns undefined when no provider carries a
 * computable health (no expectedN, or no provider returned data).
 */
export function aggregateConfidence(
  results: ProviderResult[],
  expectedN: number | undefined,
): { confidence: DataConfidence; ratio: number } | undefined {
  if (!expectedN || expectedN <= 0) return undefined;
  const ratios: number[] = [];
  for (const r of results) {
    if (r.availability === "unavailable") continue;
    const h = classifyHealth(r.sampleSize, expectedN);
    if (h) ratios.push(h.ratio);
  }
  if (ratios.length === 0) return undefined;
  const sorted = [...ratios].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  let confidence: DataConfidence;
  if (median < LOW_THRESHOLD) confidence = "insufficient";
  else if (median < HEALTHY_THRESHOLD) confidence = "low";
  else confidence = "healthy";
  return { confidence, ratio: median };
}

/** Human-readable percentage of expected, clamped to a sensible display
 *  range for tooltips. Returns "n/a" when health is undefined. */
export function formatHealthPct(ratio: number | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return "n/a";
  return `${Math.round(Math.min(ratio, 9.99) * 100)}%`;
}
