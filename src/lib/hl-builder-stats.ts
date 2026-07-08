/**
 * Server-side helper that fetches the HyperTracker-parity KPI strip for
 * one Hyperliquid frontend. Reads the `hl_frontend_*_v2` Prometheus
 * gauges that the on-node harness exposes (Sprint 1+2). Lives next to
 * the materialize/Prom plumbing rather than under `data/` because it's
 * Prom-coupled and only matters for the /products page that consumes it.
 */

import { unstable_cache } from "next/cache";
import { Prometheus } from "@/lib/prometheus";
import { getSpecs } from "@/lib/spec";
import {
  readCohortSnapshot,
  writeCohortSnapshot,
} from "@/lib/cohort-snapshot";

export type CoinShare = { coin: string; share: number };
export type PercentileBucket = {
  bucket: "top1" | "p1_5" | "p5_10" | "p10_25" | "p25_50" | "rest";
  share: number;
};

export type HlBuilderStats = {
  slug: string;
  /** USD builder-fee revenue collected over the rolling 30d. */
  revenue30d: number;
  /** Period-over-period revenue delta as a fraction (+0.40 = +40%). */
  revenueDelta30d: number;
  /** USD notional volume routed over the rolling 30d. */
  volume30d: number;
  /** Unique wallets that traded through this frontend over 30 UTC days. */
  users30d: number;
  /** $/user over 30d. Computed from revenue30d / users30d. */
  feesPerUser30d: number;
  /** Naive annualised revenue: revenue30d × 365/30. */
  annualisedRevenue: number;
  /** Share of the cohort's 24h notional volume routed by this builder
   *  (0..1). Denominator = sum across the 104 tracked builders, NOT the
   *  chain-wide HL perp volume. */
  cohortVolumeShare24h: number;
  /** Single highest UTC-day builder-fee revenue ever observed. */
  biggestDayRevenue: number;
  /** Unix timestamp (UTC day floor) when biggestDay was hit. 0 if none yet. */
  biggestDayUnix: number;
  /** Days from first observed fill until first cumulative revenue crossing
   *  for each threshold. -1 = not yet reached. */
  milestoneDays: { "10k": number; "100k": number; "1m": number };
  /** Top-15 coins by 24h notional + "other" bucket. Empty if the gauge
   *  hasn't been populated yet. */
  coinShares24h: CoinShare[];
  /** Volume share by trader-rank percentile, 30d window. Same fixed 6
   *  buckets as HyperTracker. Empty if the gauge isn't populated. */
  percentileShares30d: PercentileBucket[];
  /** Fraction of 30d-active users with realized PnL > 0 (0..1). */
  profitableUserPct30d: number;
};

/**
 * Returns the set of Hyperliquid-frontend builder slugs (= provider
 * entries on the hyperliquid-frontends bench spec). Cached for the
 * lifetime of the lambda since the spec list is build-time data.
 */
let cachedSlugs: Set<string> | null = null;
export async function isHlBuilderSlug(slug: string): Promise<boolean> {
  if (cachedSlugs === null) {
    const specs = await getSpecs();
    const hl = specs.find((s) => s.slug === "hyperliquid-frontends");
    cachedSlugs = new Set((hl?.providers ?? []).map((p) => p.slug));
  }
  return cachedSlugs.has(slug);
}

/**
 * Same as `isHlBuilderSlug` but ALSO requires the slug to be present in
 * the current history blob. Used before redirecting /products/<slug> to
 * /hyperliquid/<slug> so we never send crawlers or users into a 404: a
 * builder that's in the spec but not in the last-12-months history blob
 * (dormant, new, or paused) would otherwise 404 at the redirect target.
 * The 12-month history is the source of truth for what /hyperliquid/<slug>
 * can actually render (see hyperliquid/[slug]/page.tsx:83-85).
 */
export async function isHlBuilderWithHistory(slug: string): Promise<boolean> {
  if (!(await isHlBuilderSlug(slug))) return false;
  const history = await fetchHlHistory();
  return !!history?.frontends.some((f) => f.slug === slug);
}

function promUrl(): string | null {
  return process.env.PROMETHEUS_URL?.trim() || null;
}

const PERCENTILE_ORDER: PercentileBucket["bucket"][] = [
  "top1",
  "p1_5",
  "p5_10",
  "p10_25",
  "p25_50",
  "rest",
];

/**
 * Fetch the 6 KPI values for the strip + the Sprint-2 distribution
 * vectors. Each query is bounded by a sane abort signal; one missing
 * gauge returns 0/empty rather than propagating — the page still
 * renders, the affected section is hidden cleanly.
 *
 * Exported so the worker can call the uncached Prom path directly before
 * parking the result in Upstash; the public reader (fetchHlBuilderStats)
 * goes through the snapshot layer + unstable_cache below.
 */
export async function fetchHlBuilderStatsFresh(
  slug: string,
): Promise<HlBuilderStats | null> {
  const url = promUrl();
  if (!url) return null;
  let prom: Prometheus;
  try {
    prom = new Prometheus(url);
  } catch {
    return null;
  }
  const sel = `{builder="${slug}"}`;

  const [
    revenue30d,
    revenueDelta30d,
    volume30d,
    users30d,
    cohortShare,
    biggestDay,
    biggestDayUnix,
    milestone10k,
    milestone100k,
    milestone1m,
    profitableUserPct30d,
    coinSharesRaw,
    percentileSharesRaw,
  ] = await Promise.all([
    prom.scalar(`hl_frontend_fees_usd_30d_v2${sel}`),
    prom.scalar(`hl_frontend_revenue_delta_pct_v2{builder="${slug}",window="30d"}`),
    prom.scalar(`hl_frontend_volume_usd_30d_v2${sel}`),
    prom.scalar(`hl_frontend_users_30d_v2${sel}`),
    prom.scalar(`hl_frontend_global_volume_share_24h_v2${sel}`),
    prom.scalar(`hl_frontend_biggest_day_revenue_usd_v2${sel}`),
    prom.scalar(`hl_frontend_biggest_day_unix_v2${sel}`),
    prom.scalar(`hl_frontend_milestone_revenue_days_v2{builder="${slug}",threshold="10k"}`),
    prom.scalar(`hl_frontend_milestone_revenue_days_v2{builder="${slug}",threshold="100k"}`),
    prom.scalar(`hl_frontend_milestone_revenue_days_v2{builder="${slug}",threshold="1m"}`),
    prom.scalar(`hl_frontend_profitable_user_pct_30d_v2${sel}`),
    queryVector(prom, `hl_frontend_coin_volume_share_24h_v2${sel}`),
    queryVector(prom, `hl_frontend_volume_by_percentile_30d_v2${sel}`),
  ]);

  if (
    revenue30d === null &&
    volume30d === null &&
    users30d === null
  ) {
    return null;
  }

  const rev = revenue30d ?? 0;
  const usr = users30d ?? 0;

  const coinShares24h: CoinShare[] = (coinSharesRaw ?? [])
    .map((s) => ({ coin: s.labels.coin ?? "?", share: s.value }))
    .filter((s) => s.share > 0)
    .sort((a, b) => {
      // "other" sinks to the bottom no matter the share so the donut
      // legend always reads top coins → other.
      if (a.coin === "other") return 1;
      if (b.coin === "other") return -1;
      return b.share - a.share;
    });

  const byBucket = new Map<string, number>();
  for (const s of percentileSharesRaw ?? []) {
    const b = s.labels.bucket;
    if (b) byBucket.set(b, s.value);
  }
  const percentileShares30d: PercentileBucket[] = PERCENTILE_ORDER.map(
    (b) => ({ bucket: b, share: byBucket.get(b) ?? 0 }),
  );

  return {
    slug,
    revenue30d: rev,
    revenueDelta30d: revenueDelta30d ?? 0,
    volume30d: volume30d ?? 0,
    users30d: usr,
    feesPerUser30d: usr > 0 ? rev / usr : 0,
    annualisedRevenue: rev * (365 / 30),
    cohortVolumeShare24h: cohortShare ?? 0,
    biggestDayRevenue: biggestDay ?? 0,
    biggestDayUnix: biggestDayUnix ?? 0,
    milestoneDays: {
      "10k": milestone10k ?? -1,
      "100k": milestone100k ?? -1,
      "1m": milestone1m ?? -1,
    },
    coinShares24h,
    percentileShares30d,
    profitableUserPct30d: profitableUserPct30d ?? 0,
  };
}

/**
 * Snapshot-first reader for a single builder's dashboard payload. Same
 * protocol as the cohort readers: Upstash blob → live Prom + writeback
 * → null. Vercel prod has no Prom access post blob-only migration, so
 * the snapshot path is the only working code path in prod; the live
 * fallback exists for local dev and the worker's own recovery writes.
 */
async function fetchHlBuilderStatsRaw(
  slug: string,
): Promise<HlBuilderStats | null> {
  const snapshot = await readCohortSnapshot<HlBuilderStats>(
    `hl-builder:${slug}`,
  );
  if (snapshot) return snapshot.data;
  const fresh = await fetchHlBuilderStatsFresh(slug);
  if (fresh) {
    try {
      await writeCohortSnapshot(`hl-builder:${slug}`, fresh);
    } catch (err) {
      console.warn(
        `hl-builder:${slug} writeback failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return fresh;
}

/** Cross-request cache. The raw fn fans out 13 Prom queries per builder
 *  page render — without this, every cold visitor on a /products/<hl
 *  builder> page paid 200 to 500 ms of Prom round trips. Tagged
 *  `benchmarks` so any `revalidateTag('benchmarks')` clears alongside
 *  the rest of the bench data layer. */
const fetchHlBuilderStatsCached = unstable_cache(
  fetchHlBuilderStatsRaw,
  ["hl-builder-stats-v1"],
  { revalidate: 60, tags: ["benchmarks"] },
);

export async function fetchHlBuilderStats(
  slug: string,
): Promise<HlBuilderStats | null> {
  return fetchHlBuilderStatsCached(slug);
}

export type HlCohortRow = {
  slug: string;
  name: string;
  revenue30d: number;
  volume30d: number;
  users30d: number;
  cohortVolumeShare24h: number;
};

export type HlCohortSummary = {
  rows: HlCohortRow[];
  totalRevenue30d: number;
  totalVolume30d: number;
  totalUsers30d: number;
  asOf: number;
};

export type HlHip3Row = {
  slug: string;
  name: string;
  fees24h: number;
  fees7d: number;
  fees30d: number;
  volume24h: number;
  volume7d: number;
  volume30d: number;
  users24h: number;
  users7d: number;
  users30d: number;
  fills24h: number;
  markets24h: number;
  effectiveFeeBps: number;
};

export type HlHip3Summary = {
  rows: HlHip3Row[];
  totalFees24h: number;
  totalFees30d: number;
  totalVolume24h: number;
  totalUsers24h: number;
  asOf: number;
};

/** Upstash keys for the hub's two cohort blobs, written by
 *  /api/cron/snapshot-hl-cohort. Bump the suffix here if either summary
 *  shape changes so a stale-shape blob can never deserialize into a
 *  misaligned payload. The cohort-snapshot module appends its own `:v1`. */
const HL_FRONTENDS_KEY = "hl-frontends";
const HL_HIP3_KEY = "hl-hip3";
const HL_HISTORY_KEY = "hl-history";

/** One evenly-spaced point on a rolling-window history series. `v = null`
 *  means the underlying gauge had no sample at that timestamp (harness
 *  gap, pre-mainnet epoch, ...) — kept as a sentinel so a range's shape
 *  is stable across frontends and the chart can draw a gap instead of
 *  interpolating through zero.
 *  Legacy shape, kept exported for external consumers; the KV blob now
 *  ships the compact layout below. */
export type HlHistoryPoint = { t: number; v: number | null };
/** Compact per-frontend payload. Timestamps are reconstructed from the
 *  outer `t0 + step * i`. `firstIdx` drops leading nulls (pre-launch
 *  history for late builders); intermediate nulls stay so the chart can
 *  still draw gaps. Values are rounded to nearest USD integer. */
export type HlHistoryFrontendCompact = {
  slug: string;
  name: string;
  /** Index in the shared time axis of the first non-null sample. */
  firstIdx: number;
  /** Rolling 30d USD builder-fee revenue, one value per step from
   *  `t0 + step * firstIdx` onwards. */
  fees: (number | null)[];
  /** Rolling 30d USD notional volume, aligned with `fees`. */
  volume: (number | null)[];
};
export type HlHistorySummary = {
  /** Range fetched in ms (365d). */
  windowMs: number;
  /** Step between points in seconds (86400 = 1 day). */
  step: number;
  /** First timestamp (ms) of the shared axis. Consumers rebuild
   *  `t(i) = t0 + step * 1000 * i`. */
  t0: number;
  frontends: HlHistoryFrontendCompact[];
  /** Unix seconds when the summary was assembled. */
  asOf: number;
};

/**
 * Fetch a leaderboard-ready slice of every tracked HL builder, in 4
 * vector queries instead of 4 × 104 scalar fan-out. Used by the
 * `/hyperliquid` hub page. Returns null when Prom is unavailable so
 * the route can render a configuration banner instead of an empty
 * leaderboard.
 *
 * Volume share is summed naively across the row set rather than read
 * from the gauge; the gauge denominator is the full cohort already,
 * so the two agree. We re-compute it here so the leaderboard total
 * stays internally consistent if some builders drop out of the
 * filtered set.
 *
 * Exported so the cron route can call the uncached Prom path directly
 * before parking the result in Upstash; the public reader (fetchHlCohort)
 * goes through the snapshot layer + unstable_cache below.
 */
export async function fetchHlCohortFresh(): Promise<HlCohortSummary | null> {
  const url = promUrl();
  if (!url) return null;
  let prom: Prometheus;
  try {
    prom = new Prometheus(url);
  } catch {
    return null;
  }

  const specs = await getSpecs();
  const hl = specs.find((s) => s.slug === "hyperliquid-frontends");
  const providers = hl?.providers ?? [];
  const nameBySlug = new Map(providers.map((p) => [p.slug, p.name]));

  const [feesRaw, volumeRaw, usersRaw, shareRaw] = await Promise.all([
    queryVector(prom, `hl_frontend_fees_usd_30d_v2`),
    queryVector(prom, `hl_frontend_volume_usd_30d_v2`),
    queryVector(prom, `hl_frontend_users_30d_v2`),
    queryVector(prom, `hl_frontend_global_volume_share_24h_v2`),
  ]);

  if (feesRaw === null && volumeRaw === null && usersRaw === null) {
    return null;
  }

  const byBuilder = new Map<
    string,
    { revenue: number; volume: number; users: number; share: number }
  >();
  const ensure = (slug: string) => {
    let r = byBuilder.get(slug);
    if (!r) {
      r = { revenue: 0, volume: 0, users: 0, share: 0 };
      byBuilder.set(slug, r);
    }
    return r;
  };
  for (const s of feesRaw ?? []) {
    const b = s.labels.builder;
    if (b) ensure(b).revenue = s.value;
  }
  for (const s of volumeRaw ?? []) {
    const b = s.labels.builder;
    if (b) ensure(b).volume = s.value;
  }
  for (const s of usersRaw ?? []) {
    const b = s.labels.builder;
    if (b) ensure(b).users = s.value;
  }
  for (const s of shareRaw ?? []) {
    const b = s.labels.builder;
    if (b) ensure(b).share = s.value;
  }

  const rows: HlCohortRow[] = [];
  let totalRevenue30d = 0;
  let totalVolume30d = 0;
  let totalUsers30d = 0;
  for (const [slug, v] of byBuilder.entries()) {
    if (!nameBySlug.has(slug)) continue;
    if (v.revenue <= 0 && v.volume <= 0 && v.users <= 0) continue;
    rows.push({
      slug,
      name: nameBySlug.get(slug) ?? slug,
      revenue30d: v.revenue,
      volume30d: v.volume,
      users30d: v.users,
      cohortVolumeShare24h: v.share,
    });
    totalRevenue30d += v.revenue;
    totalVolume30d += v.volume;
    totalUsers30d += v.users;
  }
  rows.sort((a, b) => b.revenue30d - a.revenue30d);

  return {
    rows,
    totalRevenue30d,
    totalVolume30d,
    totalUsers30d,
    asOf: Math.floor(Date.now() / 1000),
  };
}

/**
 * Same shape as fetchHlCohort but for the HIP-3 deployer cohort
 * (markets-deployment-permissionless side of Hyperliquid). Powers the
 * "HIP-3 dexes" tab on `/hyperliquid`. Vector queries on the
 * `hl_hip3_deployer_*` gauges that the on-node harness exposes —
 * cardinality is naturally low (one label value per staked deployer,
 * currently 7) so a single fetch covers the whole cohort.
 *
 * Dex names come from the hyperliquid-hip3-deployers spec's providers
 * list; an unknown dex slug surfaces under its raw namespace.
 *
 * Exported so the cron route can call the uncached Prom path directly
 * before parking the result in Upstash; the public reader
 * (fetchHlHip3Cohort) goes through the snapshot layer + unstable_cache
 * below.
 */
export async function fetchHlHip3CohortFresh(): Promise<HlHip3Summary | null> {
  const url = promUrl();
  if (!url) return null;
  let prom: Prometheus;
  try {
    prom = new Prometheus(url);
  } catch {
    return null;
  }

  const specs = await getSpecs();
  const hip3Spec = specs.find((s) => s.slug === "hyperliquid-hip3-deployers");
  const nameBySlug = new Map(
    (hip3Spec?.providers ?? []).map((p) => [p.slug, p.name]),
  );

  const [
    fees24h,
    fees7d,
    fees30d,
    vol24h,
    vol7d,
    vol30d,
    users24h,
    users7d,
    users30d,
    fills24h,
    markets24h,
    effFeeBps,
  ] = await Promise.all([
    queryVector(prom, `hl_hip3_deployer_fees_usd_24h`),
    queryVector(prom, `hl_hip3_deployer_fees_usd_7d`),
    queryVector(prom, `hl_hip3_deployer_fees_usd_30d`),
    queryVector(prom, `hl_hip3_deployer_volume_usd_24h`),
    queryVector(prom, `hl_hip3_deployer_volume_usd_7d`),
    queryVector(prom, `hl_hip3_deployer_volume_usd_30d`),
    queryVector(prom, `hl_hip3_deployer_users_24h`),
    queryVector(prom, `hl_hip3_deployer_users_7d`),
    queryVector(prom, `hl_hip3_deployer_users_30d`),
    queryVector(prom, `hl_hip3_deployer_fills_24h`),
    queryVector(prom, `hl_hip3_deployer_markets_24h`),
    queryVector(prom, `hl_hip3_deployer_effective_fee_bps`),
  ]);

  if (fees24h === null && vol24h === null) return null;

  const byDex = new Map<string, HlHip3Row>();
  const ensure = (dex: string): HlHip3Row => {
    let r = byDex.get(dex);
    if (!r) {
      r = {
        slug: dex,
        name: nameBySlug.get(dex) ?? dex,
        fees24h: 0,
        fees7d: 0,
        fees30d: 0,
        volume24h: 0,
        volume7d: 0,
        volume30d: 0,
        users24h: 0,
        users7d: 0,
        users30d: 0,
        fills24h: 0,
        markets24h: 0,
        effectiveFeeBps: 0,
      };
      byDex.set(dex, r);
    }
    return r;
  };
  const apply = (
    series: { labels: Record<string, string>; value: number }[] | null,
    key: keyof Omit<HlHip3Row, "slug" | "name">,
  ) => {
    for (const s of series ?? []) {
      const d = s.labels.dex;
      if (d) ensure(d)[key] = s.value;
    }
  };
  apply(fees24h, "fees24h");
  apply(fees7d, "fees7d");
  apply(fees30d, "fees30d");
  apply(vol24h, "volume24h");
  apply(vol7d, "volume7d");
  apply(vol30d, "volume30d");
  apply(users24h, "users24h");
  apply(users7d, "users7d");
  apply(users30d, "users30d");
  apply(fills24h, "fills24h");
  apply(markets24h, "markets24h");
  apply(effFeeBps, "effectiveFeeBps");

  const rows = [...byDex.values()]
    .filter((r) => r.fees24h > 0 || r.volume24h > 0 || r.users24h > 0)
    .sort((a, b) => b.fees24h - a.fees24h);

  let totalFees24h = 0;
  let totalFees30d = 0;
  let totalVolume24h = 0;
  let totalUsers24h = 0;
  for (const r of rows) {
    totalFees24h += r.fees24h;
    totalFees30d += r.fees30d;
    totalVolume24h += r.volume24h;
    totalUsers24h += r.users24h;
  }

  return {
    rows,
    totalFees24h,
    totalFees30d,
    totalVolume24h,
    totalUsers24h,
    asOf: Math.floor(Date.now() / 1000),
  };
}

/**
 * Snapshot-first reader for the frontends cohort. Same protocol as the
 * /perps hub: Upstash blob → live Prom + writeback → null. The 60 s
 * unstable_cache wrapper around this collapses concurrent requests; the
 * cron writer keeps the Upstash blob fresh so the typical render never
 * touches Prom.
 */
async function fetchHlCohortRaw(): Promise<HlCohortSummary | null> {
  const snapshot = await readCohortSnapshot<HlCohortSummary>(HL_FRONTENDS_KEY);
  if (snapshot) return snapshot.data;
  const fresh = await fetchHlCohortFresh();
  if (fresh) {
    try {
      await writeCohortSnapshot(HL_FRONTENDS_KEY, fresh);
    } catch (err) {
      console.warn(
        `hl-frontends writeback failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return fresh;
}

const fetchHlCohortCached = unstable_cache(
  fetchHlCohortRaw,
  ["hl-frontends-cohort-v1"],
  { revalidate: 60, tags: ["hl-cohort"] },
);

export async function fetchHlCohort(): Promise<HlCohortSummary | null> {
  return fetchHlCohortCached();
}

/** Snapshot-first reader for the HIP-3 cohort. Same shape as
 *  fetchHlCohort, separate Upstash key so the two leaderboards refresh
 *  independently and a brownout on one doesn't poison the other. */
async function fetchHlHip3CohortRaw(): Promise<HlHip3Summary | null> {
  const snapshot = await readCohortSnapshot<HlHip3Summary>(HL_HIP3_KEY);
  if (snapshot) return snapshot.data;
  const fresh = await fetchHlHip3CohortFresh();
  if (fresh) {
    try {
      await writeCohortSnapshot(HL_HIP3_KEY, fresh);
    } catch (err) {
      console.warn(
        `hl-hip3 writeback failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return fresh;
}

const fetchHlHip3CohortCached = unstable_cache(
  fetchHlHip3CohortRaw,
  ["hl-hip3-cohort-v1"],
  { revalidate: 60, tags: ["hl-cohort"] },
);

export async function fetchHlHip3Cohort(): Promise<HlHip3Summary | null> {
  return fetchHlHip3CohortCached();
}

/**
 * Uncached fetch of the 12-month rolling fees + volume series for every
 * active Hyperliquid frontend (current `fees_30d > 0`, ~98 rows). Two
 * range queries per frontend (fees + volume) daily-stepped over 365d,
 * batched 20 at a time so Prom isn't hammered by ~200 concurrent range
 * scans.
 *
 * The output is written in compact form to fit under the ~300 KB blob
 * budget (Redis/Upstash comfortable range): shared time axis via `t0`
 * + `step`, per-frontend leading-null slice via `firstIdx`, rounded USD
 * integers instead of full floats. Empty series are dropped.
 *
 * Ranks the input by an instant vector on `hl_frontend_fees_usd_30d_v2`
 * so the chart's implicit "top-first" ordering matches the /hyperliquid
 * leaderboard and the client can colour the top N in order. Returns
 * null when Prom is unreachable so the reader can fall through to
 * whatever snapshot Upstash has instead of poisoning the ISR cache
 * with an empty chart.
 *
 * Exported so the worker can call the uncached Prom path directly before
 * parking the result in Upstash; the public reader (fetchHlHistory) goes
 * through the snapshot layer + unstable_cache below.
 */
export async function fetchHlHistoryFresh(): Promise<HlHistorySummary | null> {
  const url = promUrl();
  if (!url) return null;
  let prom: Prometheus;
  try {
    prom = new Prometheus(url);
  } catch {
    return null;
  }

  const specs = await getSpecs();
  const hl = specs.find((s) => s.slug === "hyperliquid-frontends");
  const providers = hl?.providers ?? [];
  const nameBySlug = new Map(providers.map((p) => [p.slug, p.name]));

  const currentFees = await queryVector(prom, `hl_frontend_fees_usd_30d_v2`);
  if (!currentFees || currentFees.length === 0) return null;

  const sorted = currentFees
    .filter((r) => Number.isFinite(r.value) && r.value > 0)
    .sort((a, b) => b.value - a.value);

  const end = Math.floor(Date.now() / 1000);
  const start = end - 365 * 86400;
  const step = 86400;
  const t0 = start * 1000;

  // Batch to keep the Prom load bounded: ~98 frontends × 2 range queries
  // = ~200 in flight if we naively Promise.all. Groups of 20 = 5 rounds
  // at 40 concurrent range queries.
  const BATCH = 20;
  const compactAll: HlHistoryFrontendCompact[] = [];
  for (let i = 0; i < sorted.length; i += BATCH) {
    const chunk = sorted.slice(i, i + BATCH);
    const results = await Promise.all(
      chunk.map(async (row) => {
        const frontend = row.labels.builder;
        if (!frontend) return null;
        const [feesRange, volumeRange] = await Promise.all([
          queryRange(
            prom,
            `hl_frontend_fees_usd_30d_v2{builder="${frontend}"}`,
            start,
            end,
            step,
          ),
          queryRange(
            prom,
            `hl_frontend_volume_usd_30d_v2{builder="${frontend}"}`,
            start,
            end,
            step,
          ),
        ]);
        if (!feesRange && !volumeRange) return null;
        return toCompactFrontend(
          frontend,
          nameBySlug.get(frontend) ?? frontend,
          feesRange ?? [],
          volumeRange ?? [],
        );
      }),
    );
    for (const r of results) {
      if (r) compactAll.push(r);
    }
  }

  if (compactAll.length === 0) return null;

  return {
    windowMs: 365 * 86400 * 1000,
    step,
    t0,
    frontends: compactAll,
    asOf: Math.floor(Date.now() / 1000),
  };
}

/** Drop leading nulls, round to integer USD, and skip the frontend
 *  entirely if both series are all-null. Intermediate nulls stay so the
 *  chart can render a gap instead of interpolating across a harness
 *  outage. */
function toCompactFrontend(
  slug: string,
  name: string,
  fees: HlHistoryPoint[],
  volume: HlHistoryPoint[],
): HlHistoryFrontendCompact | null {
  const n = Math.max(fees.length, volume.length);
  if (n === 0) return null;
  let firstIdx = -1;
  for (let i = 0; i < n; i++) {
    const f = fees[i]?.v ?? null;
    const v = volume[i]?.v ?? null;
    if (f !== null || v !== null) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx < 0) return null;
  const feesOut: (number | null)[] = [];
  const volOut: (number | null)[] = [];
  for (let i = firstIdx; i < n; i++) {
    const f = fees[i]?.v ?? null;
    const v = volume[i]?.v ?? null;
    feesOut.push(f === null ? null : Math.round(f));
    volOut.push(v === null ? null : Math.round(v));
  }
  return { slug, name, firstIdx, fees: feesOut, volume: volOut };
}

/** Snapshot-first reader for the 12-month history blob. Same Upstash
 *  → live Prom + writeback → null protocol as the two cohort readers.
 *  The historical data changes slowly (daily stepped), so the
 *  unstable_cache TTL is 1h rather than 60 s — no need to fan out
 *  20 range queries against Prom on every ISR cycle. */
async function fetchHlHistoryRaw(): Promise<HlHistorySummary | null> {
  const snapshot = await readCohortSnapshot<HlHistorySummary>(HL_HISTORY_KEY);
  if (snapshot) return snapshot.data;
  const fresh = await fetchHlHistoryFresh();
  if (fresh) {
    try {
      await writeCohortSnapshot(HL_HISTORY_KEY, fresh);
    } catch (err) {
      console.warn(
        `hl-history writeback failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return fresh;
}

const fetchHlHistoryCached = unstable_cache(
  fetchHlHistoryRaw,
  ["hl-history-v2-compact"],
  { revalidate: 3600, tags: ["hl-cohort", "hl-history"] },
);

export async function fetchHlHistory(): Promise<HlHistorySummary | null> {
  return fetchHlHistoryCached();
}

/**
 * Tiny vector helper. Returns `[{ labels, value }]` from an instant
 * vector query, or empty on error/empty result. Kept local to this
 * module because Sprint 2 is the only consumer; the broader Prometheus
 * client only needs scalars.
 */
/** Range query helper: returns evenly-stepped `{ t, v }` points for a
 *  single-series PromQL selector. If Prom returns multiple series (which
 *  shouldn't happen when the selector pins one label value) they're
 *  averaged per timestamp. Missing samples become `null` so the chart
 *  can render a gap rather than interpolating through zero. Returns null
 *  on network / Prom error so the caller can decide to skip the frontend. */
async function queryRange(
  prom: Prometheus,
  promql: string,
  startSec: number,
  endSec: number,
  stepSec: number,
): Promise<HlHistoryPoint[] | null> {
  try {
    const res = await prom.queryRange(
      promql,
      new Date(startSec * 1000),
      new Date(endSec * 1000),
      stepSec,
    );
    if (res.result.length === 0) return [];
    const buckets = new Map<number, number[]>();
    for (const series of res.result) {
      for (const [ts, raw] of series.values) {
        const v = Number(raw);
        if (!Number.isFinite(v)) continue;
        const list = buckets.get(ts) ?? [];
        list.push(v);
        buckets.set(ts, list);
      }
    }
    const points: HlHistoryPoint[] = [];
    for (let ts = startSec; ts <= endSec; ts += stepSec) {
      const vs = buckets.get(ts);
      if (!vs || vs.length === 0) {
        points.push({ t: ts * 1000, v: null });
      } else {
        const mean = vs.reduce((s, v) => s + v, 0) / vs.length;
        points.push({
          t: ts * 1000,
          v: mean === 0 ? 0 : Number(mean.toPrecision(6)),
        });
      }
    }
    return points;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `prom.queryRange failed (${reason}) for query: ${promql.slice(0, 200)}`,
    );
    return null;
  }
}

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
