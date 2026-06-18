/**
 * Color assignment for multi-line charts and leaderboard bars.
 *
 * 1. If the slug has a registered brand color (chains + a few providers,
 *    see `lib/brand.ts`), use that - Ethereum is always its purple-blue,
 *    Solana its violet, etc., across every viz on the site.
 * 2. Otherwise fall back to the muted editorial palette below in p50
 *    order. Warm paper-print tones, distinguishable but restrained.
 */

import { brandColor } from "./brand";

// Bright, saturated fallback palette - reads on light + dark backgrounds
// with high contrast. Used when a provider isn't in the brand table.
const PALETTE = [
  "#FF6B35", // vivid orange
  "#8B5CF6", // violet
  "#26D49B", // mint
  "#FFC857", // gold
  "#5B89FF", // azure
  "#FF4D8D", // hot pink
  "#22D3EE", // cyan
  "#D6FF00", // electric lime
];

/** Return a color for the i-th unbranded line. */
function lineColor(i: number): string {
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
