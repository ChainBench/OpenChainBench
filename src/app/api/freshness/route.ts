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
 * staleness lands around 15-20 s p99 — close to the Prom scrape interval
 * floor (15 s) that bounds how fresh any client-side query can ever be.
 */

// Cache window has to stay STRICTLY shorter than the LiveIndicator poll
// interval. Otherwise the same asOf is served on consecutive polls, React
// skips the canonical state update, and the client-side counter grows
// linearly until the cache finally refreshes — giving the user the
// impression that the indicator "doesn't reset on refetch".
const computeFreshness = unstable_cache(
  async (): Promise<{ now: number; freshness: Record<string, number> }> => {
    const specs = await getSpecs();
    const fallback = process.env.PROMETHEUS_URL;

    const entries = await Promise.all(
      specs.map(async (spec) => {
        const url = spec.prometheus?.url ?? fallback;
        if (!url) return [spec.slug, null] as const;
        // Use the first provider's p50 query as the freshness probe. Same
        // logic as src/lib/spec.ts tryLoadLive — keeps the asOf reported
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
    return { now: Date.now(), freshness };
  },
  ["freshness-v1"],
  { revalidate: 2, tags: ["benchmarks", "freshness"] },
);

export async function GET(req: Request) {
  const r = rateLimit(clientKey(req, "freshness"), 120, 60);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  const data = await computeFreshness();
  return Response.json(data, {
    headers: {
      // 2 s s-maxage matches the unstable_cache window above. Short swr
      // because anything beyond a few seconds produces a stale asOf that
      // would defeat the point of the polling counter.
      "cache-control": "public, s-maxage=2, stale-while-revalidate=4",
      "access-control-allow-origin": "*",
    },
  });
}
