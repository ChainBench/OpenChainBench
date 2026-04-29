/**
 * Muted editorial palette for multi-line charts. Warm paper-print tones —
 * distinguishable enough to read a tangled multi-line plot, restrained
 * enough to avoid feeling promotional. No "leader" emphasis: the order is
 * just the rotation in which we draw lines.
 */

const PALETTE = [
  "#181614", // ink
  "#7a3a25", // warm rust
  "#2c5e5e", // deep teal
  "#9c7a18", // muted ochre
  "#5a3a7a", // aged purple
  "#3d6d3d", // moss
  "#8a2a3f", // burgundy
  "#4a443c", // ink-soft
];

/** Return a color for the i-th line. Stable across renders given a fixed
 * provider order (we sort ascending by p50). */
export function lineColor(i: number): string {
  return PALETTE[i % PALETTE.length];
}
