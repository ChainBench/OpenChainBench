/**
 * Facts about Hyperliquid's public per-builder daily fills feed that both the
 * server loaders and the client components need: the windows it publishes and
 * how much of each day it actually carried.
 *
 * Split out of `hl-builder-stats` because that module reaches Prometheus and
 * Upstash, which pull `node:dns`. A type-only import from it is erased at
 * compile time and costs nothing, but importing a runtime value drags the
 * whole server module into the client chunk and the build fails on the node
 * builtin.
 */

export type HlWindow = "24h" | "7d" | "30d";

export const HL_WINDOWS: HlWindow[] = ["24h", "7d", "30d"];

/** "24h" is the last complete UTC feed day rather than a rolling window, and
 *  the column header says so to keep the reader from assuming otherwise. */
export const HL_WINDOW_LABEL: Record<HlWindow, string> = {
  "24h": "feed day",
  "7d": "7d",
  "30d": "30d",
};

/**
 * How much of each UTC day the export actually carried. Measured, not
 * assumed: the harness reads the furthest fill second in each day's file
 * across the whole cohort.
 *
 * This matters because every window figure is a sum over days. The export
 * cuts days off at roughly 12:10 UTC, intermittently since 2026-09-08 and on
 * all but one day since 2026-09-22, while on the whole days the hours before
 * 13:00 carry only about 43% of the notional and 44% of the fees. A 30d total
 * built from such a window is the right arithmetic on an incomplete feed and
 * reads about half of what a tracker on a complete feed reports. Publishing
 * the figure without the coverage beside it is the part that misleads.
 */
export type HlFeedCoverage = {
  /** Hours of the latest feed day the export carried. 24 = whole day. */
  coverageHours: number;
  /** The latest feed day stops materially short of midnight. */
  latestDayTruncated: boolean;
  /** Days inside the window the export cut short. */
  truncatedDaysWindow: number;
  /** Days in the window whose coverage was actually measured, or 0 when the
   *  harness does not report it. The count above is out of this, never out of
   *  `windowDays`: a day that left the harness's mirror window before it
   *  first ran was never measured, and treating it as clean is how the first
   *  version of this disclosure came to report 12 short days where the
   *  archive held 18. */
  daysMeasured: number;
  /** Days the window spans, for context when it differs from daysMeasured. */
  windowDays: number;
};

/**
 * Whether the reader has to be told about the feed before reading the
 * figures.
 *
 * `null` means the coverage gauges were not published, which is not the same
 * claim as "the feed is whole" and must not render as silence: a harness too
 * old to measure coverage is exactly the state this disclosure exists for.
 * So an unmeasured feed discloses, and only a feed measured whole stays
 * quiet.
 */
export function feedNeedsDisclosure(feed: HlFeedCoverage | null): boolean {
  if (!feed) return true;
  return feed.truncatedDaysWindow > 0 || feed.latestDayTruncated;
}
