/**
 * Single source of truth for live-page tunables. Centralised so we can
 * tweak cadence, window sizes, and visual budget without grepping.
 */

export const RELAY_WS_URL =
  process.env.NEXT_PUBLIC_RELAY_WS_URL ??
  "wss://ocb-stream-relay-production.up.railway.app/ws";

/** Rolling chart window length (mirrors the relay's chart_store). */
export const WINDOW_MS = 10 * 60 * 1000;
/** Bucket granularity inside the window. */
export const BUCKET_MS = 5 * 1000;

/** Cap on simultaneously rendered pops + their fade duration. */
export const MAX_POPS = 8;
export const POP_DURATION_MS = 2200;
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
export const STORAGE_FEED_OPEN = "ocb-live-feed-open";
export const STORAGE_HIDDEN_CHAINS = "ocb-live-hidden-chains";
