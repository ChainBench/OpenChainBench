import { unstable_cache } from "next/cache";
import { Prometheus, extractMetricName } from "@/lib/prometheus";
import { getSpecs } from "@/lib/spec";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { stripQueryRedirect } from "@/lib/canonical-query";

export const runtime = "nodejs";

/**
 * Ultra-light freshness probe. One Prometheus instant query for every
 * spec's probe metric (`time() - max(timestamp(<metric>))` per metric,
 * OR-ed into one union),
 * returning just the resolved data timestamp per slug.
 *
 * Separate from /api/citable so the LiveIndicator can poll cheaply
 * without re-running the heavy spec → rankings → sparkline → series
 * pipeline. It polls every 30 s (live-indicator.tsx) against a 30 s
 * s-maxage and 60 s swr, so the visible staleness lands within about a
 * minute, above the Prom scrape interval floor (15 s) that bounds how
 * fresh any client-side query can ever be. This is the shortest window on
 * the site, which is why the widget can read newer than the table beneath
 * it.
 */

// Cache window has to stay STRICTLY shorter than the LiveIndicator poll
// interval. Otherwise the same asOf is served on consecutive polls, React
// skips the canonical state update, and the client-side counter grows
// linearly until the cache finally refreshes - giving the user the
// impression that the indicator "doesn't reset on refetch".
//
// The cache key now folds in the sorted slug list so adding / removing /
// renaming a bench yml invalidates only what changed - the previous v1
// keyed on a constant ("freshness-v1") and shared one cache entry
// across every possible spec set, so a spec edit invalidated freshness
// for every other bench during the next 2 s window.
const computeFreshness = unstable_cache(
  async (
    sortedLiveSlugs: string[],
  ): Promise<{ now: number; freshness: Record<string, number> }> => {
    const liveSlugSet = new Set(sortedLiveSlugs);
    const specs = (await getSpecs()).filter(
      (s) => s.status === "live" && liveSlugSet.has(s.slug),
    );
    const fallback = process.env.PROMETHEUS_URL;

    // Use the first provider's p50 query as the freshness probe. Same
    // logic as src/lib/spec.ts tryLoadLive - keeps the asOf reported
    // here consistent with what /api/citable would compute.
    //
    // One query per Prom instance, not one per spec: the per-spec fan-out
    // was ~98 queries per fill, 509k a day, 30% of every outbound call
    // the project made (2026-10-10), and each one bills as an
    // Observability Event.
    const metricsByUrl = new Map<string, Map<string, string>>();
    for (const spec of specs) {
      const url = spec.prometheus?.url ?? fallback;
      const probe = spec.providers.find((p) => p.queries?.p50)?.queries?.p50;
      const metric = probe ? extractMetricName(probe) : null;
      if (!url || !metric) continue;
      if (!metricsByUrl.has(url)) metricsByUrl.set(url, new Map());
      metricsByUrl.get(url)!.set(spec.slug, metric);
    }

    const freshness: Record<string, number> = {};
    await Promise.all(
      [...metricsByUrl].map(async ([url, slugToMetric]) => {
        try {
          const ages = await new Prometheus(url).dataAgesSec([...slugToMetric.values()]);
          const now = Date.now();
          for (const [slug, metric] of slugToMetric) {
            const ageSec = ages.get(metric);
            if (ageSec == null || ageSec < 0) continue;
            freshness[slug] = now - Math.floor(ageSec * 1000);
          }
        } catch {
          // this instance's specs stay absent, as a failed probe did before
        }
      }),
    );
    // Store fallback: the Vercel site has no PROMETHEUS_URL (Prom lives
    // on a private VPS), so on prod every probe above fails and this
    // map came back EMPTY since launch, blanking the LiveIndicator.
    // The materialized blobs carry the worker's lastRunAt per bench,
    // minute-grained instead of scrape-grained, which is honest and far
    // better than nothing. Prom keeps priority when reachable (local
    // dev, worker context).
    if (Object.keys(freshness).length === 0) {
      try {
        const { loadAllBenchmarks } = await import("@/lib/spec");
        const all = await loadAllBenchmarks();
        for (const b of all) {
          if (!liveSlugSet.has(b.slug)) continue;
          const t = Date.parse(b.lastRunAt ?? "");
          if (Number.isFinite(t)) freshness[b.slug] = t;
        }
      } catch {
        // leave empty; the indicator degrades exactly as before
      }
    }
    return { now: Date.now(), freshness };
  },
  ["freshness-v3"],
  { revalidate: 30, tags: ["benchmarks", "freshness"] },
);

export async function GET(req: Request) {
  const canonical = stripQueryRedirect(req);
  if (canonical) return canonical;
  const r = rateLimit(clientKey(req, "freshness"), 120, 60, req);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  // Resolve the spec list outside the cached function so its slug list
  // can be part of the cache key. getSpecs() is itself memoised so this
  // is a Map read on the hot path.
  const sortedLiveSlugs = (await getSpecs())
    .filter((s) => s.status === "live")
    .map((s) => s.slug)
    .sort();
  const data = await computeFreshness(sortedLiveSlugs);
  return Response.json(data, {
    headers: {
      // 30s s-maxage matches the unstable_cache window above and the
      // Prom scrape floor (~15s). LiveIndicator polls at the same
      // cadence; client-side counter still ticks every 1s for UX.
      // Egress reduction: previously s-maxage=2 produced near-100% MISS
      // rate on Vercel edge, sending every poll to Railway prom-gateway.
      "cache-control": "public, s-maxage=30, stale-while-revalidate=60, max-age=30",
      "access-control-allow-origin": "*",
    },
  });
}
