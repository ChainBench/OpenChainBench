/**
 * Long-window series for benches whose harness keeps its own backfilled
 * history. /api/series serves 7d, 30d, 90d and 1y from Prometheus range
 * queries, which only reach back to the first scrape; a bench that
 * backfills a year (bench 266, one point per venue per UTC day) would
 * otherwise render a sliver at "now" on every range. Registering a
 * provider here makes /api/series build the dense grid from the
 * harness history instead, for the main series (not metric panels).
 *
 * The grid mirrors the route's contract: N index-aligned slots over
 * [now - window, now], null where the history has no day (today, and
 * days a venue has not closed).
 */

import { getPerpVolumeHistory } from "@/lib/perp-volume-history";

export type SeriesRange = "7d" | "30d" | "90d" | "1y";

const RANGE_DAYS: Record<SeriesRange, number> = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };

type HistoryProvider = (
  range: SeriesRange,
  providerSlugs: string[],
) => Promise<Record<string, (number | null)[]> | null>;

/** One slot per UTC day from (today - days) to today inclusive. */
function dayGrid(days: number): string[] {
  const out: string[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days; i >= 0; i--) {
    out.push(new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

const perpDailyVolume: HistoryProvider = async (range, providerSlugs) => {
  const history = await getPerpVolumeHistory();
  if (!history) return null;
  const grid = dayGrid(RANGE_DAYS[range]);
  const out: Record<string, (number | null)[]> = {};
  for (const slug of providerSlugs) {
    const venue = history.venues.find((v) => v.slug === slug);
    if (!venue || venue.days.length === 0) continue;
    const byDay = new Map(venue.days.map((p) => [p.day, p.usd]));
    const series = grid.map((d) => byDay.get(d) ?? null);
    if (series.some((v) => v !== null)) out[slug] = series;
  }
  return Object.keys(out).length > 0 ? out : null;
};

const PROVIDERS: Record<string, HistoryProvider> = {
  "perp-daily-volume": perpDailyVolume,
};

export function hasSeriesHistory(slug: string): boolean {
  return slug in PROVIDERS;
}

export async function loadSeriesHistory(
  slug: string,
  range: SeriesRange,
  providerSlugs: string[],
): Promise<Record<string, (number | null)[]> | null> {
  const provider = PROVIDERS[slug];
  if (!provider) return null;
  try {
    return await provider(range, providerSlugs);
  } catch (err) {
    console.warn(`series-history ${slug}/${range} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
