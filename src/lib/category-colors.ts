/**
 * Single source of truth for category accent colors. Used by the home
 * filter pills, the row category labels, /benchmarks group headers, and
 * the bench detail page. To onboard a new category:
 *   1. Add it to the `Category` enum in spec-schema.ts.
 *   2. Add an entry below.
 * That's the only two lines.
 */
export const CATEGORY_COLOR: Record<string, string> = {
  Aggregators: "var(--color-accent, #c97c5d)",
  Data: "var(--color-good, #6a9466)",
  Bridges: "var(--color-warn, #c08a3c)",
  Wallets: "#7a6db8",
  RPCs: "#5da0a3",
};

/** Resolve a category to its accent color, with a sensible fallback so
 * an unknown category still gets rendered (just in plain ink). */
export function categoryColor(category: string): string {
  return CATEGORY_COLOR[category] ?? "var(--color-ink-soft)";
}
