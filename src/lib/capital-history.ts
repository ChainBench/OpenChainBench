/**
 * Readers for the two daily capital blobs the worker publishes
 * (worker/publish-history.ts):
 *
 *   https://kv.openchainbench.com/aggregate/valuation/history.json
 *   https://kv.openchainbench.com/aggregate/chains/history.json
 *
 * One point per UTC day per entity, today's point overwritten until midnight
 * UTC, up to 400 days. Same protocol as perp-volume-history: fetch from the
 * CDN, parse defensively, cache 300 s. `seriesOn` maps an entity's field onto
 * a day grid for the /api/series long-window ranges (series-history.ts).
 */

import { unstable_cache } from "next/cache";

const VALUATION_URL = "https://kv.openchainbench.com/aggregate/valuation/history.json";
const CHAINS_URL = "https://kv.openchainbench.com/aggregate/chains/history.json";

export type CapitalPoint = { day: string } & Record<string, number>;

export type CapitalEntity = {
  slug: string;
  name?: string;
  category?: string;
  days: CapitalPoint[];
};

export type ValuationHistory = {
  generatedAt: string;
  /** Bench 274 cohort: mcap, fdv, float_pct, fees_30d, rev_30d, tvl, pf, pf_fdv, ps,
   *  price_change_30d_pct, fee_growth_30d_pct, supply_change_30d_pct, supply_change_90d_pct,
   *  fees_incomplete, revenue_incomplete (0/1). */
  protocols: CapitalEntity[];
  /** Bench 265 cohort: mcap, fdv, float_pct, fees_30d, rev_30d, pf, pf_fdv, ps, oi. */
  perps: CapitalEntity[];
};

export type ChainsHistory = {
  generatedAt: string;
  /** tvl, bridged_tvl, tvs, stables_mcap, stables_net_30d, native_mcap, dex_volume_24h, fees_30d, revenue_30d. */
  chains: CapitalEntity[];
};

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function parseEntities(raw: unknown): CapitalEntity[] {
  if (!Array.isArray(raw)) return [];
  const out: CapitalEntity[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (typeof o.slug !== "string") continue;
    const days: CapitalPoint[] = [];
    if (Array.isArray(o.days)) {
      for (const p of o.days) {
        if (!p || typeof p !== "object") continue;
        const q = p as Record<string, unknown>;
        if (typeof q.day !== "string") continue;
        const point: CapitalPoint = { day: q.day } as CapitalPoint;
        for (const [k, v] of Object.entries(q)) {
          if (k !== "day" && isNumber(v)) point[k] = v;
        }
        days.push(point);
      }
    }
    days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    out.push({
      slug: o.slug,
      name: typeof o.name === "string" ? o.name : undefined,
      category: typeof o.category === "string" ? o.category : undefined,
      days,
    });
  }
  return out;
}

export function parseValuationHistory(raw: unknown): ValuationHistory | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.generated_at !== "string") return null;
  return {
    generatedAt: r.generated_at,
    protocols: parseEntities(r.protocols),
    perps: parseEntities(r.perps),
  };
}

export function parseChainsHistory(raw: unknown): ChainsHistory | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.generated_at !== "string") return null;
  return { generatedAt: r.generated_at, chains: parseEntities(r.chains) };
}

async function fetchJson(url: string, label: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000), next: { revalidate: 300 } });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`${label} read failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const getValuationCached = unstable_cache(
  async () => parseValuationHistory(await fetchJson(process.env.VALUATION_HISTORY_URL?.trim() || VALUATION_URL, "valuation-history")),
  ["valuation-history-v1"],
  { revalidate: 300, tags: ["capital-history"] },
);

const getChainsCached = unstable_cache(
  async () => parseChainsHistory(await fetchJson(process.env.CHAINS_HISTORY_URL?.trim() || CHAINS_URL, "chains-history")),
  ["chains-history-v1"],
  { revalidate: 300, tags: ["capital-history"] },
);

export async function getValuationHistory(): Promise<ValuationHistory | null> {
  return getValuationCached();
}

export async function getChainsHistory(): Promise<ChainsHistory | null> {
  return getChainsCached();
}

/**
 * The long-window series for /api/series: the blob answers only the 90d and
 * 1y ranges, and only once it covers the whole grid (its first stored day on
 * or before the grid's first day). Everything else returns null so the route
 * keeps its materialized 7d/30d series and its Prometheus range fallback:
 * on the day the blobs shipped they held one point, and serving that for
 * every range would have blanked the charts of four live benches (review
 * 2026-09-25).
 */
export function seriesForRange(
  entity: CapitalEntity | undefined,
  field: string,
  range: string,
  grid: string[],
): (number | null)[] | null {
  if (range !== "90d" && range !== "1y") return null;
  if (!entity || entity.days.length === 0 || grid.length === 0) return null;
  const first = entity.days.find((p) => isNumber(p[field]))?.day;
  if (!first || first > grid[0]) return null;
  return seriesOn(entity, field, grid);
}

/**
 * One entity's field on a day grid (null where the day has no point or the
 * point lacks the field). Days are "YYYY-MM-DD".
 */
export function seriesOn(entity: CapitalEntity | undefined, field: string, grid: string[]): (number | null)[] | null {
  if (!entity || entity.days.length === 0) return null;
  const byDay = new Map(entity.days.map((p) => [p.day, p[field]]));
  const series = grid.map((d) => {
    const v = byDay.get(d);
    return isNumber(v) ? v : null;
  });
  return series.some((v) => v !== null) ? series : null;
}
