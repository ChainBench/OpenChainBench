import { unstable_cache } from "next/cache";
import { Prometheus } from "@/lib/prometheus";
import { getSpecs } from "@/lib/spec";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Ultra-light freshness probe. One Prometheus instant query per spec
 * (`scalar(time() - max(timestamp(<metric>)))`), returning just the
 * resolved data timestamp per slug.
 *
 * Separate from /api/citable so the LiveIndicator can poll fast (every
 * 8 s) without re-running the heavy spec → rankings → sparkline → series
 * pipeline. Edge-cache is short (5 s s-maxage, 20 s swr) so the visible
 * staleness lands around 15-20 s p99 - close to the Prom scrape interval
 * floor (15 s) that bounds how fresh any client-side query can ever be.
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

    const entries = await Promise.all(
      specs.map(async (spec) => {
        const url = spec.prometheus?.url ?? fallback;
        if (!url) return [spec.slug, null] as const;
        // Use the first provider's p50 query as the freshness probe. Same
        // logic as src/lib/spec.ts tryLoadLive - keeps the asOf reported
        // here consistent with what /api/citable would compute.
        const probe = spec.providers.find((p) => p.queries?.p50)?.queries?.p50;
        if (!probe) return [spec.slug, null] as const;
        try {
          const prom = new Prometheus(url);
          const ageSec = await prom.dataAgeSec(probe);
          if (ageSec == null || !Number.isFinite(ageSec) || ageSec < 0) {
            return [spec.slug, null] as const;
          }
          return [spec.slug, Date.now() - Math.floor(ageSec * 1000)] as const;
        } catch {
          return [spec.slug, null] as const;
        }
      }),
    );

    const freshness: Record<string, number> = {};
    for (const [slug, asOf] of entries) {
      if (asOf != null) freshness[slug] = asOf;
    }
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
