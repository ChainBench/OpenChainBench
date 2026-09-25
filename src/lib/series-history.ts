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
import { getChainsHistory, getValuationHistory, seriesForRange, type CapitalEntity } from "@/lib/capital-history";

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

/**
 * Long-window providers backed by the daily capital blobs
 * (worker/publish-history.ts). Each maps a bench's p50 measure onto the
 * entity field the blob stores under the same name, so a 90d or 1y range on
 * these benches reads a year of daily points instead of Prometheus range
 * queries bounded by the bench's first scrape.
 */
function capitalProvider(
  load: () => Promise<{ entities: CapitalEntity[] } | null>,
  field: string,
): HistoryProvider {
  return async (range, providerSlugs) => {
    // 7d and 30d stay on the materialized series; 90d and 1y come from the
    // blob only once it covers the whole range (seriesForRange), otherwise
    // null hands the route back to its Prometheus range query.
    if (range !== "90d" && range !== "1y") return null;
    const history = await load();
    if (!history) return null;
    const grid = dayGrid(RANGE_DAYS[range]);
    const out: Record<string, (number | null)[]> = {};
    for (const slug of providerSlugs) {
      const series = seriesForRange(history.entities.find((e) => e.slug === slug), field, range, grid);
      if (series) out[slug] = series;
    }
    return Object.keys(out).length > 0 ? out : null;
  };
}

const valuationProtocols = async () => {
  const h = await getValuationHistory();
  return h ? { entities: h.protocols } : null;
};
const valuationPerps = async () => {
  const h = await getValuationHistory();
  return h ? { entities: h.perps } : null;
};
const chains = async () => {
  const h = await getChainsHistory();
  return h ? { entities: h.chains } : null;
};

const PROVIDERS: Record<string, HistoryProvider> = {
  "perp-daily-volume": perpDailyVolume,
  // p50 = protocol_pf_ratio{protocol} / perp_protocol_pf_ratio{protocol}
  "protocol-pf-ratio": capitalProvider(valuationProtocols, "pf"),
  "perp-pf-ratio": capitalProvider(valuationPerps, "pf"),
  // p50 = chain_bridged_tvl_usd{chain} / chain_stables_net_30d_usd{chain}
  "chain-bridged-tvl": capitalProvider(chains, "bridged_tvl"),
  "chain-stablecoin-flow": capitalProvider(chains, "stables_net_30d"),
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
