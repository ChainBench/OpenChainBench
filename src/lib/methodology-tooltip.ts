/**
 * Build the hover-tooltip string shown on every chart row / bar / slice
 * across the bench detail page. Centralises the format so RankedBar,
 * Distribution and Donut all show the same shape - readers learn the
 * convention once and recognise it everywhere.
 *
 * Includes:
 *   - The provider's friendly name
 *   - The raw PromQL query that produced the headline number (when
 *     spec.ts could extract it - falls back to the metric name)
 *   - A click-to-toggle hint so the interaction is discoverable from
 *     the tooltip without needing a separate help string
 *
 * Plain string output (no JSX) because <title> only renders text. A
 * richer popover-style tooltip is a future upgrade if hover ergonomics
 * stop being enough.
 */

type ProviderLike = {
  name: string;
  query?: string;
};

export function methodologyTooltip(
  r: ProviderLike,
  isExcluded: boolean,
): string {
  const lines = [r.name];
  if (r.query) {
    lines.push("");
    lines.push(`Computed from: ${r.query}`);
  }
  lines.push("");
  lines.push(
    isExcluded
      ? "Click to include in the chart"
      : "Click to hide from the chart",
  );
  return lines.join("\n");
}
