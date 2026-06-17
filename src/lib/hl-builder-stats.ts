/**
 * Server-side helper that fetches the HyperTracker-parity KPI strip for
 * one Hyperliquid frontend. Reads the `hl_frontend_*_v2` Prometheus
 * gauges that the on-node harness exposes (Sprint 1+2). Lives next to
 * the materialize/Prom plumbing rather than under `data/` because it's
 * Prom-coupled and only matters for the /products page that consumes it.
 */

import { Prometheus } from "@/lib/prometheus";
import { getSpecs } from "@/lib/spec";

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
 */
export async function fetchHlBuilderStats(
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
 * Tiny vector helper. Returns `[{ labels, value }]` from an instant
 * vector query, or empty on error/empty result. Kept local to this
 * module because Sprint 2 is the only consumer; the broader Prometheus
 * client only needs scalars.
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
