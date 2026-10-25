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
  /** Days in the window read from our own Hyperliquid node's fill stream
   *  rather than the public per-builder export. A day sourced there is whole;
   *  the export cuts most days off around 12:10 UTC. */
  nodeDays: number;
  /** Days in the window served as reconstructions: the export's own morning
   *  spliced to an afternoon rebuilt per wallet from Hyperliquid's info API,
   *  for outages the node cannot replay. How close they land varies with how
   *  much of the day the morning covered, from -0.4% to -28% across the two
   *  days scored against the node, so `rebuiltWorstErrorPct` carries the
   *  magnitude and this is only the count. Never folded into `nodeDays`, and
   *  told to the reader because a reconstruction presented as a measurement
   *  is the one thing this disclosure exists to prevent. */
  rebuiltDays: number;
  /** Largest expected shortfall among the rebuilt days in the window, as a
   *  negative percent, and 0 when none are rebuilt. A rebuilt day's accuracy
   *  follows how much of it the export's morning covered: two complete days
   *  scored against the node gave -0.4% at a 68.8% morning and -28.2% at
   *  27.2%. The worst of the window rather than its mean, because what a
   *  reader needs is how wrong the figure could be, and averaging a -0.5%
   *  day with a -35% one describes neither. */
  rebuiltWorstErrorPct: number;
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

/**
 * Whether the window is whole enough that the note should read as a footnote
 * rather than a warning.
 *
 * Most of the window now comes from our own node, which publishes every hour
 * of every day it was up. What is left is the handful of days the node was
 * down, which fall back to the public export and are short. Those days still
 * pull a 30-day total down by a few per cent and the reader should be told,
 * but a page whose figures are 0.96x of a full-feed tracker should not carry
 * the same red banner as one whose figures were 0.53x.
 */
export function feedIsMostlyWhole(feed: HlFeedCoverage | null): boolean {
  if (!feed) return false;
  if (feed.windowDays <= 0) return false;
  return feed.nodeDays >= feed.windowDays - 5;
}

/**
 * How the window's days divide between the three sources the page can name.
 *
 * The disclosure note used to describe the whole window as the public
 * export's. That was true for as long as it was written, because the node
 * substitution never reached the running binary: the harness image was
 * rebuilt on 2026-10-21 from a source tree frozen on 2026-10-07, hours
 * before the substitution merged, so the deployed process had no node code
 * at all. Once a current binary shipped on 2026-10-25 the same sentence
 * became wrong in two directions at once. It named the export as the source
 * of days the node had measured, and it described a window reading 43% low
 * when most of it no longer did, which understates our own figures.
 *
 * exportDays is the remainder, floored at 0 and clamped so the three counts
 * sum to windowDays. The gauges are set in one pass of one process, but a
 * scrape that lands mid-pass can pair a node count from the new window with
 * a rebuilt count from the old, and a negative day count in prose is a
 * worse failure than a conservative zero.
 */
export function hlDaySources(feed: HlFeedCoverage): {
  nodeDays: number;
  rebuiltDays: number;
  exportDays: number;
} {
  const windowDays = Math.max(0, feed.windowDays);
  const nodeDays = Math.max(0, Math.min(windowDays, feed.nodeDays));
  const rebuiltDays = Math.max(
    0,
    Math.min(windowDays - nodeDays, feed.rebuiltDays),
  );
  return {
    nodeDays,
    rebuiltDays,
    exportDays: windowDays - nodeDays - rebuiltDays,
  };
}
