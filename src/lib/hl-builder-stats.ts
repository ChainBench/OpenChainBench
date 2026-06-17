/**
 * Server-side helper that fetches the HyperTracker-parity KPI strip for
 * one Hyperliquid frontend. Reads the `hl_frontend_*_v2` Prometheus
 * gauges that the on-node harness exposes (Sprint 1+2). Lives next to
 * the materialize/Prom plumbing rather than under `data/` because it's
 * Prom-coupled and only matters for the /products page that consumes it.
 */

import { Prometheus } from "@/lib/prometheus";
import { getSpecs } from "@/lib/spec";

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

/**
 * Fetch the 6 KPI values for the strip. Each query is bounded by a
 * sane abort signal; one missing gauge returns 0 rather than
 * propagating an error — the page still renders, the affected card
 * shows a long-dash placeholder which is honest about what's missing.
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
  ]);

  // A builder that has no series at all (= the bench Prom hasn't seen
  // it under the slug=label, e.g. brand-new add) should fall through to
  // the page's normal product layout rather than render a useless empty
  // dashboard.
  if (
    revenue30d === null &&
    volume30d === null &&
    users30d === null
  ) {
    return null;
  }

  const rev = revenue30d ?? 0;
  const usr = users30d ?? 0;
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
  };
}
