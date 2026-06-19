/**
 * Server-side data fetchers for the per-venue and per-data-feed deep-dive
 * sections on /prediction-markets.
 *
 * Two sources:
 *  1. Polymarket gamma-api (no auth, public) for the "top markets" table.
 *     Hit directly with a short revalidate window so the table stays warm
 *     across renders without hammering gamma.
 *  2. Per-venue Prom gauges from the PM bench harnesses (rate-limits 037,
 *     api-latency 038, resolution-delay 039, data-freshness 032) for the
 *     KPI strip and the bench-cards row.
 *
 * The 90d volume + open-interest history is NOT on gamma-api. The plan is
 * a separate Vercel cron that snapshots daily totals into Upstash KV
 * (`pm:daily:<venue>:<date>`). Until that lands, fetchPmVenueHistory
 * returns null and the chart component hides itself.
 */

import { unstable_cache } from "next/cache";
import { Prometheus } from "@/lib/prometheus";

const GAMMA_TOP_MARKETS_URL =
  "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=10";

/** A single market row from gamma-api (we keep only the fields we render). */
export type PmTopMarket = {
  question: string;
  slug: string;
  url: string;
  endDate: string | null;
  volume24h: number;
  openInterest: number | null;
  /** Highest outcome probability (0..1). */
  probability: number | null;
  /** Category bucket, derived from `tags`. */
  category: "Politics" | "Sports" | "Crypto" | "Macro" | "Other";
};

export type PmVenueKpis = {
  /** USD 30d traded volume. */
  volume30d: number | null;
  /** USD outstanding open interest. */
  openInterest: number | null;
  /** Number of active markets right now. */
  activeMarkets: number | null;
  /** Median resolution delay in seconds (onchain venues only). */
  medianResolutionSec: number | null;
  /** API latency p50 in ms (bench 038). */
  apiP50Ms: number | null;
  /** API latency p99 in ms (bench 038). */
  apiP99Ms: number | null;
  /** 24h uptime fraction (0..1). */
  uptime24h: number | null;
  /** Headroom on documented public rate-limit (0..1, only offchain). */
  rateLimitHeadroom: number | null;
  /** Count of markets with > $1m volume in the last 30d (offchain only). */
  marketsAbove1m: number | null;
};

export type PmDataFeedKpis = {
  /** Freshness p50 vs Polymarket CLOB T0, in ms (bench 032). */
  freshnessP50Ms: number | null;
  /** Freshness p99 in ms. */
  freshnessP99Ms: number | null;
  /** 24h uptime fraction (0..1). */
  uptime24h: number | null;
  /** Slugs of venues this feed covers (e.g. ["polymarket","kalshi"]). */
  venueCoverage: string[];
  /** True when this provider is the reference (Polymarket CLOB). */
  isReference: boolean;
};

export type PmVenueHistoryPoint = {
  date: number; // unix seconds, UTC day floor
  volume: number; // USD traded that UTC day
  oi: number | null; // USD open interest at day close, null if unknown
};

export type PmVenueHistory = {
  slug: string;
  days: number;
  points: PmVenueHistoryPoint[];
};

export type PmCategoryShare = {
  category: PmTopMarket["category"];
  share: number; // 0..1
};

/* ------------------------------------------------------------------ *
 *  TOP MARKETS (gamma-api)                                            *
 * ------------------------------------------------------------------ */

type GammaMarket = {
  question?: string;
  slug?: string;
  endDate?: string;
  volume24hr?: number | string;
  openInterest?: number | string;
  outcomePrices?: string | string[];
  tags?: Array<{ label?: string; slug?: string } | string>;
};

function classifyCategory(tags: GammaMarket["tags"]): PmTopMarket["category"] {
  if (!tags) return "Other";
  const labels = tags
    .map((t) =>
      typeof t === "string" ? t : (t.label ?? t.slug ?? "").toString(),
    )
    .map((s) => s.toLowerCase());

  // First match wins; order matters because some markets carry overlapping
  // tags (e.g. "Trump 2024" + "Politics" + "Election").
  if (labels.some((l) => /(politic|election|president|congress|senate)/.test(l)))
    return "Politics";
  if (
    labels.some((l) =>
      /(sport|nfl|nba|mlb|nhl|soccer|football|tennis|ufc|f1|formula|olymp|world cup)/.test(
        l,
      ),
    )
  )
    return "Sports";
  if (
    labels.some((l) =>
      /(crypto|bitcoin|btc|ethereum|eth|solana|sol|memecoin|defi)/.test(l),
    )
  )
    return "Crypto";
  if (
    labels.some((l) =>
      /(macro|economy|fed|rate|inflation|cpi|gdp|recession|jobs)/.test(l),
    )
  )
    return "Macro";
  return "Other";
}

function parseOutcomePrices(raw: GammaMarket["outcomePrices"]): number | null {
  if (!raw) return null;
  let arr: unknown;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return null;
    }
  } else {
    arr = raw;
  }
  if (!Array.isArray(arr)) return null;
  const nums = arr
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v >= 0 && v <= 1);
  if (nums.length === 0) return null;
  return Math.max(...nums);
}

async function fetchPmTopMarketsRaw(
  venueSlug: string,
): Promise<PmTopMarket[] | null> {
  // For v1 only Polymarket is wired to gamma-api. Other venues return null
  // and the table renders a "data feed not live yet" empty state.
  if (venueSlug !== "polymarket") return null;
  try {
    const res = await fetch(GAMMA_TOP_MARKETS_URL, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(`gamma-api top markets http ${res.status}`);
      return null;
    }
    const body = (await res.json()) as GammaMarket[] | { data?: GammaMarket[] };
    const list = Array.isArray(body) ? body : (body.data ?? []);
    return list
      .filter((m) => m.question && m.slug)
      .slice(0, 10)
      .map((m): PmTopMarket => {
        const vol = Number(m.volume24hr ?? 0);
        const oi =
          m.openInterest != null && Number.isFinite(Number(m.openInterest))
            ? Number(m.openInterest)
            : null;
        return {
          question: String(m.question),
          slug: String(m.slug),
          url: `https://polymarket.com/event/${m.slug}`,
          endDate: m.endDate ?? null,
          volume24h: Number.isFinite(vol) ? vol : 0,
          openInterest: oi,
          probability: parseOutcomePrices(m.outcomePrices),
          category: classifyCategory(m.tags),
        };
      });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`fetchPmTopMarkets failed (${reason}) for ${venueSlug}`);
    return null;
  }
}

const fetchPmTopMarketsCached = unstable_cache(
  fetchPmTopMarketsRaw,
  ["pm-top-markets-v1"],
  { revalidate: 300, tags: ["pm-markets"] },
);

export async function fetchPmTopMarkets(
  venueSlug: string,
): Promise<PmTopMarket[] | null> {
  return fetchPmTopMarketsCached(venueSlug);
}

/* ------------------------------------------------------------------ *
 *  CATEGORY DONUT (derived)                                           *
 * ------------------------------------------------------------------ */

/** Derive a 5-slice category split from the top-markets sample, weighted
 *  by 24h volume. Sufficient for v1; a proper 30d split needs the daily
 *  snapshot job to land. */
export function deriveCategoryShares(
  markets: PmTopMarket[] | null,
): PmCategoryShare[] | null {
  if (!markets || markets.length === 0) return null;
  const buckets = new Map<PmTopMarket["category"], number>([
    ["Politics", 0],
    ["Sports", 0],
    ["Crypto", 0],
    ["Macro", 0],
    ["Other", 0],
  ]);
  let total = 0;
  for (const m of markets) {
    const v = m.volume24h || 0;
    buckets.set(m.category, (buckets.get(m.category) ?? 0) + v);
    total += v;
  }
  if (total <= 0) return null;
  return [...buckets.entries()].map(([category, vol]) => ({
    category,
    share: vol / total,
  }));
}

/* ------------------------------------------------------------------ *
 *  PROM GAUGES (per-venue + per-data-feed)                            *
 * ------------------------------------------------------------------ */

function promUrl(): string | null {
  return process.env.PROMETHEUS_URL?.trim() || null;
}

async function fetchPmVenueKpisRaw(
  slug: string,
): Promise<PmVenueKpis | null> {
  const url = promUrl();
  if (!url) return null;
  let prom: Prometheus;
  try {
    prom = new Prometheus(url);
  } catch {
    return null;
  }
  const sel = `{venue="${slug}"}`;

  const [
    volume30d,
    openInterest,
    activeMarkets,
    medianResolutionSec,
    apiP50Ms,
    apiP99Ms,
    uptime24h,
    rateLimitHeadroom,
    marketsAbove1m,
  ] = await Promise.all([
    prom.scalar(`pm_venue_volume_30d_usd${sel}`),
    prom.scalar(`pm_venue_open_interest_usd${sel}`),
    prom.scalar(`pm_venue_active_markets${sel}`),
    prom.scalar(
      `histogram_quantile(0.5, sum by (le) (rate(pmres_resolution_delay_seconds_bucket${sel}[7d])))`,
    ),
    prom.scalar(
      `1000 * histogram_quantile(0.5, sum by (le) (rate(pmapi_request_duration_seconds_bucket${sel}[1h])))`,
    ),
    prom.scalar(
      `1000 * histogram_quantile(0.99, sum by (le) (rate(pmapi_request_duration_seconds_bucket${sel}[1h])))`,
    ),
    prom.scalar(`avg_over_time(pmapi_health${sel}[24h])`),
    prom.scalar(`pm_venue_rate_limit_headroom${sel}`),
    prom.scalar(`pm_venue_markets_above_1m_30d${sel}`),
  ]);

  // If every probe returned null assume the venue isn't wired yet.
  if (
    volume30d === null &&
    openInterest === null &&
    activeMarkets === null &&
    apiP50Ms === null &&
    uptime24h === null
  ) {
    return null;
  }

  return {
    volume30d,
    openInterest,
    activeMarkets,
    medianResolutionSec,
    apiP50Ms,
    apiP99Ms,
    uptime24h,
    rateLimitHeadroom,
    marketsAbove1m,
  };
}

const fetchPmVenueKpisCached = unstable_cache(
  fetchPmVenueKpisRaw,
  ["pm-venue-kpis-v1"],
  { revalidate: 120, tags: ["pm-venue"] },
);

export async function fetchPmVenueKpis(
  slug: string,
): Promise<PmVenueKpis | null> {
  return fetchPmVenueKpisCached(slug);
}

async function fetchPmDataFeedKpisRaw(
  slug: string,
): Promise<PmDataFeedKpis | null> {
  // Polymarket CLOB is the T0 reference; skip the freshness probe.
  if (slug === "polymarket-clob") {
    return {
      freshnessP50Ms: null,
      freshnessP99Ms: null,
      uptime24h: null,
      venueCoverage: ["polymarket"],
      isReference: true,
    };
  }
  const url = promUrl();
  if (!url) return null;
  let prom: Prometheus;
  try {
    prom = new Prometheus(url);
  } catch {
    return null;
  }
  const sel = `{relay="${slug}"}`;

  const [p50, p99, uptime, coverageRaw] = await Promise.all([
    prom.scalar(`avg by () (pm_freshness_p50_ms${sel})`),
    prom.scalar(`avg by () (pm_freshness_p99_ms${sel})`),
    prom.scalar(`avg_over_time(pmapi_health{venue="${slug}"}[24h])`),
    // Distinct venue labels present on the freshness gauge tell us the
    // venues this feed actively reports on. Using count by(venue) and
    // pulling label names out client-side via a vector query.
    prom.query(`count by (venue) (pm_freshness_p50_ms${sel})`),
  ]);

  let venueCoverage: string[] = [];
  if (coverageRaw && coverageRaw.resultType === "vector") {
    venueCoverage = coverageRaw.result
      .map((r) => r.metric.venue)
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .sort();
  }

  if (p50 === null && p99 === null && uptime === null && venueCoverage.length === 0) {
    return null;
  }

  return {
    freshnessP50Ms: p50,
    freshnessP99Ms: p99,
    uptime24h: uptime,
    venueCoverage,
    isReference: false,
  };
}

const fetchPmDataFeedKpisCached = unstable_cache(
  fetchPmDataFeedKpisRaw,
  ["pm-feed-kpis-v1"],
  { revalidate: 120, tags: ["pm-feed"] },
);

export async function fetchPmDataFeedKpis(
  slug: string,
): Promise<PmDataFeedKpis | null> {
  return fetchPmDataFeedKpisCached(slug);
}

/* ------------------------------------------------------------------ *
 *  HISTORY (Upstash KV, optional)                                     *
 * ------------------------------------------------------------------ */

type UpstashRow = { date: number; volume?: number; oi?: number | null };

/**
 * Read up to `days` daily snapshots from Upstash. The cron writes one
 * key per UTC day under `pm:daily:<venue>:<YYYY-MM-DD>` with a JSON
 * payload `{ date, volume, oi }`. We hit the REST mget endpoint with a
 * pre-built key list so we get atomic latency regardless of series gaps.
 *
 * Returns null when Upstash isn't configured OR when no snapshot exists
 * yet. The chart component handles null by hiding.
 */
async function fetchPmVenueHistoryRaw(
  slug: string,
  days: number,
): Promise<PmVenueHistory | null> {
  const baseUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!baseUrl || !token) return null;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000);
    const ymd = d.toISOString().slice(0, 10);
    keys.push(`pm:daily:${slug}:${ymd}`);
  }

  try {
    // Upstash REST: `POST /mget/key1/key2/...` returns `{ result: [...] }`
    // with one entry per key (null when missing).
    const res = await fetch(`${baseUrl}/mget/${keys.join("/")}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`upstash mget http ${res.status} for ${slug}`);
      return null;
    }
    const body = (await res.json()) as { result?: (string | null)[] };
    const raws = body.result ?? [];
    const points: PmVenueHistoryPoint[] = [];
    for (let i = 0; i < raws.length; i++) {
      const raw = raws[i];
      if (!raw) continue;
      try {
        const row = JSON.parse(raw) as UpstashRow;
        const v = Number(row.volume ?? 0);
        const oi = row.oi == null ? null : Number(row.oi);
        if (!Number.isFinite(v)) continue;
        points.push({
          date: row.date,
          volume: v,
          oi: oi !== null && Number.isFinite(oi) ? oi : null,
        });
      } catch {
        // Skip malformed rows, don't kill the whole series.
      }
    }
    if (points.length < 7) return null;
    return { slug, days, points };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`fetchPmVenueHistory failed (${reason}) for ${slug}`);
    return null;
  }
}

const fetchPmVenueHistoryCached = unstable_cache(
  fetchPmVenueHistoryRaw,
  ["pm-venue-history-v1"],
  { revalidate: 600, tags: ["pm-history"] },
);

export async function fetchPmVenueHistory(
  slug: string,
  days = 90,
): Promise<PmVenueHistory | null> {
  return fetchPmVenueHistoryCached(slug, days);
}
