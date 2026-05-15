/**
 * Color assignment for multi-line charts and leaderboard bars.
 *
 * 1. If the slug has a registered brand color (chains + a few providers,
 *    see `lib/brand.ts`), use that — Ethereum is always its purple-blue,
 *    Solana its violet, etc., across every viz on the site.
 * 2. Otherwise fall back to the muted editorial palette below in p50
 *    order. Warm paper-print tones, distinguishable but restrained.
 */

import { brandColor } from "./brand";

const PALETTE = [
  "#64748b", // slate
  "#a16207", // amber
  "#0d9488", // teal
  "#7c3aed", // violet
  "#16a34a", // green
  "#c2410c", // rust
  "#db2777", // pink
  "#0284c7", // sky
];

/** Return a color for the i-th unbranded line. */
export function lineColor(i: number): string {
  return PALETTE[i % PALETTE.length];
}

/** Build a stable slug → color map from a provider list. Branded slugs
 * (chains + known providers) get their brand color directly. Unbranded
 * slugs are assigned palette colors in ascending p50 order so adjacent
 * leaders sit next to each other in the legend. */
export function buildProviderColors<
  T extends { slug: string; ms: { p50: number } }
>(results: T[]): Map<string, string> {
  const sorted = [...results].sort((a, b) => a.ms.p50 - b.ms.p50);
  const map = new Map<string, string>();
  let paletteIdx = 0;
  for (const r of sorted) {
    const branded = brandColor(r.slug);
    if (branded) {
      map.set(r.slug, branded);
    } else {
      map.set(r.slug, lineColor(paletteIdx));
      paletteIdx += 1;
    }
  }
  return map;
}
