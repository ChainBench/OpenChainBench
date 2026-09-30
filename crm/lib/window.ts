/**
 * The dashboard's reporting window.
 *
 * Every windowed figure on the site used to be a fixed "last 7 days against
 * the 7 before it". That is the right default for a site read by a few
 * hundred people a week, and the wrong one on the day something ships: a
 * launch that triples today's traffic moves a 7-day average by a seventh,
 * so the page that is supposed to show the spike flattens it.
 *
 * So the window is a parameter now, and `?w=24h` switches the whole
 * dashboard to a day against the day before. The comparison window is
 * always the same length as the window itself, which is what the deltas on
 * every card already assumed.
 *
 * Adding a window does NOT cost a second round of PostHog queries per page
 * view: the refresh runs the windowed sections once per window and stores
 * both, and the pages read whichever the reader asked for. See
 * TRAFFIC_SECTIONS / WINDOWED_SECTIONS in traffic.ts for the split between
 * the sections that depend on the window and the long series that do not.
 */
export type WindowKey = "7d" | "24h";

export type ReportWindow = {
  key: WindowKey;
  /** Length of the window, in days. The comparison window is the same. */
  days: number;
  /** Suffix for a card or table heading: "Visitors, 7 d". */
  label: string;
  /** Suffix for a delta: "vs previous 7 d". */
  prevLabel: string;
  /** Header for a delta column in a table. "w/w" under a 24 h window said
   *  week over week over a comparison that was a day. */
  deltaLabel: string;
};

export const WINDOWS: Record<WindowKey, ReportWindow> = {
  "7d": { key: "7d", days: 7, label: "7 d", prevLabel: "previous 7 d", deltaLabel: "w/w" },
  "24h": { key: "24h", days: 1, label: "24 h", prevLabel: "previous 24 h", deltaLabel: "d/d" },
};

export const DEFAULT_WINDOW: WindowKey = "7d";
export const WINDOW_KEYS = Object.keys(WINDOWS) as WindowKey[];

/** Reads ?w= off a page's searchParams. Anything unknown is the default,
 *  so a stale or hand-edited link renders the dashboard rather than an error. */
export function parseWindow(raw: string | string[] | undefined): ReportWindow {
  const key = Array.isArray(raw) ? raw[0] : raw;
  return WINDOWS[(key ?? "") as WindowKey] ?? WINDOWS[DEFAULT_WINDOW];
}

/** Adds ?w= to an in-app href, and leaves the default window implicit so
 *  the URLs people share stay the ones they already have. */
export function withWindow(href: string, w: ReportWindow): string {
  if (w.key === DEFAULT_WINDOW) return href;
  return `${href}${href.includes("?") ? "&" : "?"}w=${w.key}`;
}
