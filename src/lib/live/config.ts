/**
 * Single source of truth for live-page tunables. Centralised so we can
 * tweak cadence, window sizes, and visual budget without grepping.
 */

export const RELAY_WS_URL =
  process.env.NEXT_PUBLIC_RELAY_WS_URL ??
  "wss://ocb-stream-relay-production.up.railway.app/ws";

/** Default range opened on the live chart. */
export const DEFAULT_RANGE: import("./types").RangeKey = "10m";
/** Human labels for the range tab strip. */
export const RANGE_LABELS: Record<import("./types").RangeKey, string> = {
  "10m": "Last 10 min",
  "1h": "Last hour",
  "24h": "Last 24h",
};
/** Pops only make sense on the live (10m) range. */
export const POP_RANGE: import("./types").RangeKey = "10m";

/** Cap on simultaneously rendered pops + their fade duration. */
export const MAX_POPS = 5;
export const POP_DURATION_MS = 1500;
/** Vertical offset (% of chart height) applied between stacked pops
 *  so simultaneous events don't overlap at the right edge. */
export const POP_STACK_OFFSET_PCT = 9;
/** Horizontal anchor for pops — left of the chart-end so labels and
 *  endpoint dots stay readable. */
export const POP_ANCHOR_X_PCT = 82;
/** Minimum swap USD that earns a pop (dust filter). */
export const POP_MIN_USD = 1;

/** Compact feed buffer size (browser-side rolling list). */
export const MAX_FEED = 50;

/** SVG viewBox for the live chart. */
export const CHART_W = 1100;
export const CHART_H = 280;
export const CHART_PAD_X = 40;
export const CHART_PAD_Y = 20;

/** Lag color thresholds shown in the compact feed. */
export const LAG_GREEN_MS = 1000;
export const LAG_AMBER_MS = 3000;

/** Whale USD thresholds for visual emphasis in the feed. */
export const BIG_USD = 10_000;
export const WHALE_USD = 100_000;

/** localStorage keys. */
export const STORAGE_HIDDEN_CHAINS = "ocb-live-hidden-chains";
export const STORAGE_LIVE_EXPANDED = "ocb-live-expanded";
