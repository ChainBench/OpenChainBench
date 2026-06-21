/**
 * Server-side helper for the /prediction-markets hub page. Reads the
 * `pm_venue_*` gauges exposed by the `pm-cohort-stats` harness, plus a
 * handful of cross-bench histograms already in prod:
 *   - pmapi_request_duration_seconds_bucket   (bench pm-api-latency)
 *   - pm_health                               (bench pm-data-freshness, uptime)
 *   - pmres_resolution_delay_seconds_bucket   (bench pm-resolution-delay)
 *   - pm_freshness_delta_ms_bucket            (bench pm-data-freshness)
 *
 * The freshness bench publishes a histogram keyed by
 * `{provider, venue, kind}` (NOT a pre-aggregated p50/p99 gauge), so we
 * compute the quantile client-side via `histogram_quantile()` and key
 * the data-feed rows by the `provider` label.
 *
 * Shape mirrors `hl-builder-stats.ts` exactly so the page composes the
 * same way as /hyperliquid: one server fetch, one client tab swap.
 *
 * Venue and data feed registries are hardcoded here because the cohort
 * is curated, small, and shared with the bench specs. Mismatched slugs
 * are rendered with null fields; the page degrades gracefully.
 */

import { Prometheus } from "@/lib/prometheus";

export type PmVenueType = "onchain" | "offchain";

export type PmVenueRow = {
  slug: string;
  name: string;
  type: PmVenueType;
  chain?: string;
  volume30d: number | null;
  volume24h: number | null;
  openInterest: number | null;
  activeMarkets: number | null;
  topMarketVolume24h: number | null;
  marketsAbove1m: number | null;
  medianResolutionDelayMin: number | null;
  p50ApiLatencyMs: number | null;
};

export type PmDataFeedRow = {
  slug: string;
  name: string;
  freshnessP50Ms: number | null;
  freshnessP99Ms: number | null;
  uptime24h: number | null;
  coverage: string[];
  isReference: boolean;
};

export type PmCohortSummary = {
  venues: PmVenueRow[];
  dataFeeds: PmDataFeedRow[];
  totals: {
    volume30d: number;
    activeMarkets: number;
    medianResolutionDelayMin: number | null;
    p50ApiLatencyMs: number | null;
  };
  asOf: number;
};

type VenueSeed = {
  slug: string;
  name: string;
  type: PmVenueType;
  chain?: string;
};

type DataFeedSeed = {
  slug: string;
  name: string;
  coverage: string[];
  isReference: boolean;
};

const PM_VENUES: VenueSeed[] = [
  { slug: "polymarket", name: "Polymarket", type: "onchain",  chain: "polygon" },
  { slug: "kalshi",     name: "Kalshi",     type: "offchain" },
  { slug: "limitless",  name: "Limitless",  type: "onchain",  chain: "base" },
  { slug: "manifold",   name: "Manifold",   type: "offchain" },
  { slug: "myriad",     name: "Myriad",     type: "offchain" },
];

const PM_DATA_FEEDS: DataFeedSeed[] = [
  { slug: "mobula", name: "Mobula", coverage: ["polymarket"], isReference: false },
  { slug: "codex",  name: "Codex",  coverage: ["polymarket"], isReference: false },
];

function promUrl(): string | null {
  return process.env.PROMETHEUS_URL?.trim() || null;
}

/**
 * Fetch the venue + data feed cohort in one Promise.all fan out. Returns
 * null when Prom is unreachable so the page renders a configuration
 * banner instead of an empty leaderboard. A reachable Prom that simply
 * has no series yet (harness not yet deployed) returns a fully populated
 * shape with every numeric field nulled; the leaderboard then shows
 * dashes and the page stays useful.
 */
export async function fetchPmCohort(): Promise<PmCohortSummary | null> {
  const url = promUrl();
  if (!url) return null;
  let prom: Prometheus;
  try {
    prom = new Prometheus(url);
  } catch {
    return null;
  }

  const [
    vol30d,
    vol24h,
    oi,
    activeMarkets,
    topMarketVol24h,
    marketsAbove1m,
    apiLatencyP50,
    resolutionDelayP50,
    freshnessP50,
    freshnessP99,
    uptime24h,
  ] = await Promise.all([
    queryVector(prom, `pm_venue_volume_30d_usd`),
    queryVector(prom, `pm_venue_volume_24h_usd`),
    queryVector(prom, `pm_venue_open_interest_usd`),
    queryVector(prom, `pm_venue_active_markets`),
    queryVector(prom, `pm_venue_top_market_volume_24h_usd`),
    queryVector(prom, `pm_venue_markets_above_1m`),
    // p50 over the last 24h of warm, non cached price requests, in ms.
    // class="price" + conn="warm" mirrors the bench page's headline.
    queryVector(
      prom,
      `1000 * histogram_quantile(0.5, sum by (venue, le) (rate(pmapi_request_duration_seconds_bucket{class="price",conn="warm"}[24h])))`,
    ),
    // Median resolution delay across the trailing 30d window, in seconds.
    // The harness exposes a histogram with no venue label today (single
    // venue: Polymarket), so this resolves to a single series we attach
    // to polymarket only.
    queryVector(
      prom,
      `histogram_quantile(0.5, sum by (le) (rate(pmres_resolution_delay_seconds_bucket[30d])))`,
    ),
    queryVector(
      prom,
      `histogram_quantile(0.5, sum by (provider, le) (rate(pm_freshness_delta_ms_bucket{venue="polymarket",provider!="polymarket"}[1h])))`,
    ),
    queryVector(
      prom,
      `histogram_quantile(0.99, sum by (provider, le) (rate(pm_freshness_delta_ms_bucket{venue="polymarket",provider!="polymarket"}[1h])))`,
    ),
    queryVector(
      prom,
      `avg_over_time(pm_health{venue="polymarket",provider!="polymarket"}[24h])`,
    ),
  ]);

  // Map raw vectors onto the venue rows. Order of the seed list is kept
  // so the default leaderboard ordering is predictable until the user
  // sorts by a metric.
  const byVenue = new Map<string, PmVenueRow>();
  for (const v of PM_VENUES) {
    byVenue.set(v.slug, {
      slug: v.slug,
      name: v.name,
      type: v.type,
      chain: v.chain,
      volume30d: null,
      volume24h: null,
      openInterest: null,
      activeMarkets: null,
      topMarketVolume24h: null,
      marketsAbove1m: null,
      medianResolutionDelayMin: null,
      p50ApiLatencyMs: null,
    });
  }

  const apply = (
    series: { labels: Record<string, string>; value: number }[] | null,
    field: keyof Omit<PmVenueRow, "slug" | "name" | "type" | "chain">,
  ) => {
    for (const s of series ?? []) {
      const v = s.labels.venue;
      if (!v) continue;
      const row = byVenue.get(v);
      if (!row) continue;
      row[field] = s.value;
    }
  };

  apply(vol30d, "volume30d");
  apply(vol24h, "volume24h");
  apply(oi, "openInterest");
  apply(activeMarkets, "activeMarkets");
  apply(topMarketVol24h, "topMarketVolume24h");
  apply(marketsAbove1m, "marketsAbove1m");
  apply(apiLatencyP50, "p50ApiLatencyMs");

  // Resolution delay is venue free in the current harness; attribute the
  // single series to Polymarket. When the bench grows to cover more
  // venues, the gauge will sprout a `venue` label and this block will
  // pick it up automatically via the apply() path above.
  const resolutionSeries = resolutionDelayP50 ?? [];
  for (const s of resolutionSeries) {
    const v = s.labels.venue ?? "polymarket";
    const row = byVenue.get(v);
    if (!row) continue;
    row.medianResolutionDelayMin = Number.isFinite(s.value) ? s.value / 60 : null;
  }

  // Data feeds. Coverage stays static (taken from the seed); the live
  // values come from the freshness bench, which keys by `provider`. The
  // T0 reference (Polymarket CLOB) is excluded from PM_DATA_FEEDS since
  // measuring it against itself would always yield zero lag.
  const freshnessP50By = new Map<string, number>();
  const freshnessP99By = new Map<string, number>();
  const uptimeBy = new Map<string, number>();
  for (const s of freshnessP50 ?? []) {
    const r = s.labels.provider;
    if (r) freshnessP50By.set(r, s.value);
  }
  for (const s of freshnessP99 ?? []) {
    const r = s.labels.provider;
    if (r) freshnessP99By.set(r, s.value);
  }
  for (const s of uptime24h ?? []) {
    const r = s.labels.provider;
    if (r) uptimeBy.set(r, s.value);
  }
  const dataFeeds: PmDataFeedRow[] = PM_DATA_FEEDS.map((f) => ({
    slug: f.slug,
    name: f.name,
    freshnessP50Ms: f.isReference ? null : (freshnessP50By.get(f.slug) ?? null),
    freshnessP99Ms: f.isReference ? null : (freshnessP99By.get(f.slug) ?? null),
    uptime24h: f.isReference ? null : (uptimeBy.get(f.slug) ?? null),
    coverage: f.coverage,
    isReference: f.isReference,
  }));

  // Cohort totals. Sums skip nulls; medians use venue level p50 latency
  // (median of medians) which is good enough for a hero card.
  const venues = [...byVenue.values()];
  let totalVolume30d = 0;
  let totalActiveMarkets = 0;
  for (const r of venues) {
    if (r.volume30d != null) totalVolume30d += r.volume30d;
    if (r.activeMarkets != null) totalActiveMarkets += r.activeMarkets;
  }
  const apiP50s = venues
    .map((r) => r.p50ApiLatencyMs)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const resDelays = venues
    .map((r) => r.medianResolutionDelayMin)
    .filter((v): v is number => v != null && Number.isFinite(v));

  return {
    venues,
    dataFeeds,
    totals: {
      volume30d: totalVolume30d,
      activeMarkets: totalActiveMarkets,
      medianResolutionDelayMin: resDelays.length ? median(resDelays) : null,
      p50ApiLatencyMs: apiP50s.length ? median(apiP50s) : null,
    },
    asOf: Math.floor(Date.now() / 1000),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Tiny vector helper mirroring the one in hl-builder-stats.ts. Kept
 * local so this module stays self contained; the broader Prometheus
 * client only exposes scalars.
 */
async function queryVector(
  prom: Prometheus,
  promql: string,
): Promise<{ labels: Record<string, string>; value: number }[] | null> {
  try {
    const res = await prom.query(promql);
    if (res.resultType !== "vector") return [];
    return res.result
      .map((r) => ({
        labels: r.metric,
        value: Number(r.value[1]),
      }))
      .filter((r) => Number.isFinite(r.value));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `prom.queryVector failed (${reason}) for query: ${promql.slice(0, 200)}`,
    );
    return null;
  }
}
