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
  Blockchains: "#3b6fb5",
  Trading: "#a05688",
  Bridges: "var(--color-warn, #c08a3c)",
  Wallets: "#7a6db8",
  RPCs: "#5da0a3",
  Explorers: "#7a6fa8",
  // NFT APIs: indigo, distinct from the warm orange/red accents already
  // in use. Picks up OpenSea/Alchemy/Moralis brand palettes which all
  // cluster around blues/purples.
  "NFT APIs": "#6366f1",
  // RWA: teal, the tradfi-meets-onchain lane gets its own hue.
  RWA: "#0d9488",
};
