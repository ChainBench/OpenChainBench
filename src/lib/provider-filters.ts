import type { ProviderResult } from "@/types/benchmark";

/**
 * Field of providers the leaderboard treats as "live this cycle".
 *
 * Two conditions both need to hold:
 *   - `availability !== "unavailable"` — the spec loader marks providers
 *     with no Prom data this cycle as unavailable so the augmented zero
 *     entries don't poison the ranking.
 *   - `ms.p50 > 0` — defensive fallback for legacy entries (or chart-
 *     specific zero placeholders) that slipped through without the
 *     availability flag.
 *
 * Centralised so the rule lives in one place instead of being copied
 * across every chart component, the stats helpers, and the spec
 * placeholder renderer. Update here when the definition of "live"
 * changes (e.g. add a min sample-size threshold).
 */
export function liveResults(results: ProviderResult[]): ProviderResult[] {
  return results.filter((r) => {
    if (r.availability === "unavailable") return false;
    // Rows the loader marked live carry real aggregates whatever their
    // sign (bridge-realized-cost: Mobula at -$0.0038 and LI.FI at
    // -$0.00008 were dropped from the ranking on 2026-09-19 by the
    // positive-only guard, and Relay was crowned). The `> 0` guard stays
    // for legacy rows without the flag.
    if (r.availability === "live") return Number.isFinite(r.ms.p50);
    return r.ms.p50 > 0;
  });
}

/**
 * Minimum success rate (0-100) for a row to appear in the ranked
 * display surfaces (ledger table, bar chart, per-chain comparison).
 * Prometheus gauges retain their last value when the harness fails,
 * so a chain that once measured <1 s but has been dead for 24 h
 * still holds a non-zero p50 while its success rate collapses to 0 %.
 * The all-zero filter in liveResults does not catch this case; this
 * floor does. Kept deliberately low (5 %) so occasionally-flaky rows
 * are still shown, while completely dead ones (0 %, 0.28 %) are
 * excluded from the ranking. citation.ts uses a separate 50 % floor
 * for the citable leader claim; display and citation thresholds are
 * intentionally decoupled.
 */
export const MIN_DISPLAY_SUCCESS_PCT = 5;

/** liveResults filtered by the display success floor. Use for ranked
 *  surfaces (ledger, bar chart, per-chain pages). Do NOT use in the
 *  citation path — citation.ts applies its own 50 % floor separately. */
export function displayResults(results: ProviderResult[]): ProviderResult[] {
  return liveResults(results).filter(
    (r) => (r.successRate ?? 100) >= MIN_DISPLAY_SUCCESS_PCT,
  );
}

/**
 * The RPC thin gate, in one place. A chain RPC bench with fewer than three
 * declared results is noindex (src/app/benchmarks/[slug]/page.tsx) and the
 * worker keeps it out of the sitemap; hubs and the benchmarks index must not
 * link it either (Search Console 2026-09-19: /rpc and /benchmarks linked 36
 * such pages, crawl spent on noindex dead ends).
 */
export const THIN_RPC_MIN_RESULTS = 3;
export function isThinRpcBench(b: { category: string; results?: unknown[] | null }): boolean {
  return b.category === "RPCs" && (b.results?.length ?? 0) < THIN_RPC_MIN_RESULTS;
}

/** Age of a bench's data in hours, from `lastRunAt`; Infinity when unknown.
 *  A chain RPC page whose harness stopped answering (chain dropped from the
 *  probe roster, endpoint dead) keeps `status: live` and the old numbers
 *  (Prometheus gauges hold their last value). Six such pages were indexed
 *  on production on 2026-09-19 with "updated every 60s" in the snippet and
 *  data 11 to 34 days old. */
export function dataAgeHours(b: { lastRunAt?: string | null }): number {
  const ms = Date.parse(b.lastRunAt ?? "");
  return Number.isFinite(ms) ? (Date.now() - ms) / 3_600_000 : Number.POSITIVE_INFINITY;
}
/** Data older than a day: the snippet and the TL;DR must say so. */
export const STALE_AFTER_HOURS = 24;
/** Data older than a week: the page is noindex and leaves the sitemap. */
export const NOINDEX_AFTER_HOURS = 168;
export function isStaleBench(b: { lastRunAt?: string | null; status?: string }): boolean {
  return b.status === "live" && dataAgeHours(b) > STALE_AFTER_HOURS;
}
export function isExpiredBench(b: { lastRunAt?: string | null; status?: string }): boolean {
  return b.status === "live" && dataAgeHours(b) > NOINDEX_AFTER_HOURS;
}

/** The chain RPC page gate, app side, in one place: a `<chain>-rpc` bench
 *  is linked and listed only when it is not thin (declared cohort) and its
 *  data is not expired. The worker applies the same rule to the sitemap
 *  blob; the app repeats it so a stale blob (or a worker built from an
 *  older branch) never makes the sitemap, the hubs, the sibling nav or
 *  llms.txt list a noindex page. Works on the slim sitemap rows too. */
export function isExpiredRpcPage(b: {
  slug: string;
  category?: string;
  lastRunAt?: string | null;
  status?: string;
}): boolean {
  if (!b.slug.endsWith("-rpc") || (b.category && b.category !== "RPCs")) return false;
  return dataAgeHours(b) > NOINDEX_AFTER_HOURS;
}

/** The same week-old gate, for any bench rather than chain RPC pages only.
 *  A bench that loses quorum keeps serving its last good render, which is
 *  the right call for a Prometheus brownout and the wrong one once the
 *  render has aged out: perp-asset-breadth sat in the sitemap with
 *  `index, follow` and data from 2026-08-17 for five weeks, because every
 *  expiry check downstream was RPC-shaped. Works on the slim sitemap rows,
 *  which carry slug, status and lastRunAt and nothing else. */
export function isExpiredPage(b: {
  slug: string;
  category?: string;
  lastRunAt?: string | null;
  status?: string;
}): boolean {
  return isExpiredBench(b) || isExpiredRpcPage(b);
}
