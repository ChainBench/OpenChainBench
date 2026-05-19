/**
 * Single source of truth for live-page tunables. Centralised so we can
 * tweak cadence, window sizes, and visual budget without grepping.
 */

export const RELAY_WS_URL =
  process.env.NEXT_PUBLIC_RELAY_WS_URL ??
  "wss://ocb-stream-relay-production.up.railway.app/ws";

/** Default range opened on the live chart. */
export const DEFAULT_RANGE: import("./types").RangeKey = "10m";
/** Human labels for the range picker. */
export const RANGE_LABELS: Record<import("./types").RangeKey, string> = {
  "10m": "Last 10 min",
  "1h": "Last hour",
  "24h": "Last 24h",
};

/** Cap on simultaneously rendered pops + their fade duration. */
export const MAX_POPS = 5;
/** Pop lifetime before fade-out. Bumped from 1.5 s once Multi-Events
 *  became active: pops were appearing and disappearing too fast to
 *  read at 1-2/sec spawn rate. 3.5 s gives the eye enough time to
 *  register each one, MAX_POPS=5 still caps screen clutter. */
export const POP_DURATION_MS = 3500;
/** Vertical offset (% of chart height) applied between stacked pops
 *  so simultaneous events don't overlap at the right edge. */
export const POP_STACK_OFFSET_PCT = 9;
/** Horizontal anchor for pops — left of the chart-end so labels and
 *  endpoint dots stay readable. */
export const POP_ANCHOR_X_PCT = 82;
/** Minimum swap USD that earns a pop. Multi-Events sends ~230 evt/s;
 *  $10k floor keeps pops sparse enough (~0.5-1/sec) that combined
 *  with POP_DURATION_MS = 3.5 s each bubble has time to be seen
 *  before another lands on top. */
export const POP_MIN_USD = 10_000;

/** Minimum swap USD before a row is pushed into the compact feed.
 *  Same rationale as POP_MIN_USD but a softer threshold so the feed
 *  still shows context, not just whales. */
export const FEED_MIN_USD = 500;

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
