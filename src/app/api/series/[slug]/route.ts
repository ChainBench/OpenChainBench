import { NextResponse } from "next/server";
import { getBenchmark } from "@/data/benchmarks";
import { loadSpecsUncached, specToBenchmark } from "@/lib/materialize/load";
import { buildProviderColors } from "@/lib/series-colors";
import { logoPath } from "@/lib/logo-manifest";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { SLUG_RE } from "@/lib/slug";

export const runtime = "nodejs";
export const revalidate = 60;

/**
 * Per-bench, per-provider time series. Mirrors /api/stat in shape and
 * headers but exposes the raw `extras.series{24h,7d,30d}` slabs as a
 * BenchPayload-ready payload — provider name + brand color + logo
 * joined inline, timestamps reconstructed from the Prom window since
 * the underlying storage drops them.
 *
 * Consumer: the OpenChainBench Export Video modal, which needs honest
 * trajectories to drive race compositions. Designed to be cacheable at
 * the CDN edge (60s s-maxage, 300s swr) — the data underneath only
 * refreshes when the spec loader re-runs.
 */

const RANGE_CONFIG = {
  "24h": { windowMs: 24 * 3600 * 1000, points: 72 },
  "7d": { windowMs: 7 * 24 * 3600 * 1000, points: 84 },
  "30d": { windowMs: 30 * 24 * 3600 * 1000, points: 60 },
} as const;

type RangeKey = keyof typeof RANGE_CONFIG;

function isRangeKey(s: string): s is RangeKey {
  return s in RANGE_CONFIG;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const r = rateLimit(clientKey(req, "series"), 60, 60, req);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  const { slug } = await params;
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400 });
  }

  const url = new URL(req.url);
  const rangeParam = url.searchParams.get("range") ?? "24h";
  if (!isRangeKey(rangeParam)) {
    return NextResponse.json(
      { error: "bad_range", supported: Object.keys(RANGE_CONFIG) },
      { status: 400 },
    );
  }
  const providersFilter = url.searchParams.get("providers");
  const allowedSlugs = providersFilter
    ? new Set(providersFilter.split(",").map((s) => s.trim()).filter(Boolean))
    : null;

  // Honor the same dimensional filters the bench page itself supports
  // (?chain=ethereum, ?region=eu-west). Without this, benches whose series
  // only have data per-chain (e.g. network-fees) appear empty in the
  // unfiltered global view even though the chain-scoped data is fine.
  const chain = url.searchParams.get("chain") ?? undefined;
  const region = url.searchParams.get("region") ?? undefined;

  // For 7d / 30d ranges we bypass the unstable_cache (which strips those
  // series to stay under 2 MB — see slimBenchmarkForCache in spec.ts)
  // and query Prom directly. The route's HTTP cache-control headers
  // below (60 s s-maxage + 300 s SWR) absorb the load at the Vercel
  // CDN edge, so at most one Prom fan-out per (bench, range, scope)
  // every 60 s regardless of concurrent visitor count.
  let b;
  if (rangeParam === "7d" || rangeParam === "30d") {
    const specs = await loadSpecsUncached();
    const spec = specs.find((s) => s.slug === slug);
    if (!spec || spec.status !== "live") {
      return NextResponse.json(
        { error: "unknown_slug", slug },
        { status: 404, headers: { "cache-control": "public, s-maxage=60" } },
      );
    }
    b = await specToBenchmark(spec, { chain, region });
  } else {
    b = await getBenchmark(slug, { chain, region });
  }
  if (!b || b.editorialStatus !== "live") {
    return NextResponse.json(
      { error: "unknown_slug", slug },
      { status: 404, headers: { "cache-control": "public, s-maxage=60" } },
    );
  }

  const seriesMap =
    rangeParam === "24h"
      ? b.extras.series24h
      : rangeParam === "7d"
        ? b.extras.series7d
        : b.extras.series30d;

  if (!seriesMap || Object.keys(seriesMap).length === 0) {
    return NextResponse.json(
      { error: "no_data_for_range", slug, range: rangeParam },
      { status: 404, headers: { "cache-control": "public, s-maxage=60" } },
    );
  }

  // Timestamps are not persisted with the series — reconstruct from the
  // Prom window. We trust whatever length the series came back with
  // (Prom may drop empty buckets) so each provider's values stay aligned
  // with the timestamp array.
  const { windowMs, points: targetPoints } = RANGE_CONFIG[rangeParam];
  const firstSeries = Object.values(seriesMap).find((arr) => arr.length > 0);
  const actualPoints = firstSeries?.length ?? targetPoints;
  const stepMs = windowMs / Math.max(1, actualPoints);
  const endMs = Date.now();
  const startMs = endMs - windowMs;
  const timestamps: number[] = [];
  for (let i = 0; i < actualPoints; i++) {
    timestamps.push(Math.round(startMs + i * stepMs));
  }

  const colors = buildProviderColors(b.results);

  // Logos are served from OCB's /public/logos/*. The video renderer is
  // an external service that has no access to our public folder, so we
  // emit absolute URLs against the requesting host. Headless Chromium
  // fetches them over HTTPS during render, same as a browser would.
  const reqUrl = new URL(req.url);
  const origin = `${reqUrl.protocol}//${reqUrl.host}`;
  const absolutize = (p: string) => (p.startsWith("http") ? p : `${origin}${p}`);

  const providers = b.results
    .filter((p) => seriesMap[p.slug] && seriesMap[p.slug].length > 0)
    .filter((p) => !allowedSlugs || allowedSlugs.has(p.slug))
    .map((p) => {
      const values = seriesMap[p.slug];
      const logo = logoPath(p.slug);
      return {
        slug: p.slug,
        name: p.name,
        color: colors.get(p.slug) ?? "#7f7f7f",
        ...(logo ? { logo: absolutize(logo) } : {}),
        values,
      };
    });

  return NextResponse.json(
    {
      slug: b.slug,
      title: b.title,
      metric: b.metric,
      unit: b.unit,
      higherIsBetter: b.higherIsBetter,
      range: rangeParam,
      timestamps,
      providers,
    },
    {
      headers: {
        "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
        "access-control-allow-origin": "*",
      },
    },
  );
}
