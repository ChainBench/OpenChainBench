import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getBenchmark } from "@/data/benchmarks";
import { filterSig, loadSpecsUncached, specToBenchmark } from "@/lib/materialize/load";
import { readMaterialized } from "@/lib/materialize/store";
import { loadSnapshotFromBlob } from "@/lib/bench-blob";
import { buildProviderColors } from "@/lib/series-colors";
import { logoPath } from "@/lib/logo-manifest";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { SLUG_RE } from "@/lib/slug";
import { matchesChainSlug } from "@/lib/chain-aliases";

// Dedicated cache for the (slug, range, chain, region, kind, venue) →
// series map.
// The full Benchmark is too big for unstable_cache's 2 MB limit (root
// cause of the egress blowout — see slimBenchmarkForCache in spec.ts),
// but the series map alone is at most ~100 KB even for 100-provider
// benches.
//
// Read order: worker-published blob first (full bench, includes series7d
// + series30d), then the live Prom fan-out as a last resort. Without the
// blob lookup every cold CDN miss paid a 30-50 Prom-query roundtrip;
// under load those would queue at the Prom concurrency cap and time out
// the Vercel function. The blob is updated by the worker on each sweep
// so reading it stays as fresh as our materialize cadence (~60 s).
const getSeriesMapCached = unstable_cache(
  async (
    slug: string,
    range: "7d" | "30d",
    chain: string | undefined,
    region: string | undefined,
    kind: string | undefined,
    venue: string | undefined,
    panelId: string | undefined,
  ): Promise<Record<string, (number | null)[]> | null> => {
    const sig = filterSig({ chain, region, kind, venue });
    // Try CDN blob first (Phase 3), fall back to Redis via SRH.
    const stored =
      (await loadSnapshotFromBlob(slug, sig)) ??
      (await readMaterialized(slug, sig));
    if (stored) {
      // Panel-scoped lookup: returns the companion-metric series for a
      // specific metricPanel (?panel=<id>), not the main bench series.
      // Without this, panels have no way to render 7d/30d — the
      // slimBenchmarkForCache strip drops panel long-range series from
      // the payload and the chart falls back to a disabled tab.
      if (panelId) {
        const panel = stored.bench.metricPanels?.find((p) => p.id === panelId);
        const fromPanel =
          range === "7d"
            ? panel?.seriesByProvider7d
            : panel?.seriesByProvider30d;
        if (fromPanel && Object.keys(fromPanel).length > 0) return fromPanel;
      } else {
        const fromBlob =
          range === "7d"
            ? stored.bench.extras.series7d
            : stored.bench.extras.series30d;
        if (fromBlob && Object.keys(fromBlob).length > 0) return fromBlob;
      }
    }
    // Fallback: blob missing (newly deployed bench) or empty for this
    // variant. Run the live build to seed something; the worker will
    // overwrite on its next sweep.
    const specs = await loadSpecsUncached();
    const spec = specs.find((s) => s.slug === slug);
    if (!spec || spec.status !== "live") return null;
    const b = await specToBenchmark(spec, { chain, region, kind, venue });
    if (panelId) {
      const panel = b.metricPanels?.find((p) => p.id === panelId);
      return (range === "7d"
        ? panel?.seriesByProvider7d
        : panel?.seriesByProvider30d) ?? null;
    }
    return (range === "7d" ? b.extras.series7d : b.extras.series30d) ?? null;
  },
  // v5: added ?panel=<id> variant for companion-metric long-range series.
  // v4 keys omit the panelId slot; keep the version bumped so old cache
  // entries don't collide with the new signature.
  ["series-by-range-v5"],
  { revalidate: 300, tags: ["benchmarks"] },
);

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
  const panelId = url.searchParams.get("panel")?.trim() || undefined;

  // Honor the same dimensional filters the bench page itself supports
  // (?chain=ethereum, ?region=eu-west, ?kind=..., ?venue=...). Without
  // this, benches whose series only have data per-chain (e.g.
  // network-fees) appear empty in the unfiltered global view even though
  // the chain-scoped data is fine.
  //
  // Same validation/canonicalization as /api/bench/[slug]/variant: every
  // filter is checked against the declared dimensions and replaced by the
  // canonical value, since these end up in PromQL label selectors.
  const aggregate = await getBenchmark(slug);
  if (!aggregate || aggregate.editorialStatus !== "live") {
    return NextResponse.json(
      { error: "unknown_slug", slug },
      { status: 404, headers: { "cache-control": "public, s-maxage=60" } },
    );
  }

  const filters: { chain?: string; region?: string; kind?: string; venue?: string } = {};
  for (const dim of ["chain", "region", "kind", "venue"] as const) {
    const raw = url.searchParams.get(dim)?.toLowerCase().trim();
    if (!raw || raw === "all") continue;
    // Canonical-aware matching: the chain dimension may still hold the
    // legacy slug ("ton") even though clients now request the canonical
    // ("gram"). The matcher resolves both sides to canonical.
    const known = (aggregate.dimensions?.[dim] ?? []).find((d) =>
      dim === "chain"
        ? matchesChainSlug(d.value, raw)
        : d.value.toLowerCase() === raw,
    );
    if (!known) {
      return NextResponse.json(
        { error: `unknown_${dim}`, [dim]: raw },
        { status: 400, headers: { "cache-control": "public, s-maxage=60" } },
      );
    }
    filters[dim] = known.value;
  }
  const hasFilters = Object.keys(filters).length > 0;

  // 24h is served from the slim cached Benchmark (cheap). 7d / 30d
  // come from the dedicated getSeriesMapCached above (Prom fan-out the
  // first time, then 5 min of free reads from unstable_cache). Loading
  // a 100-KB series map is cheap enough that we still need the row
  // metadata (name, color, logo) — fetch the cached bench for that
  // separately so its slim ~50 KB payload reuses the existing cache.
  let seriesMap: Record<string, (number | null)[]> | undefined | null;
  let bench;
  if (rangeParam === "7d" || rangeParam === "30d") {
    [seriesMap, bench] = await Promise.all([
      getSeriesMapCached(
        slug,
        rangeParam,
        filters.chain,
        filters.region,
        filters.kind,
        filters.venue,
        panelId,
      ),
      hasFilters ? getBenchmark(slug, filters) : Promise.resolve(aggregate),
    ]);
  } else {
    bench = hasFilters ? await getBenchmark(slug, filters) : aggregate;
    if (panelId) {
      const panel = bench?.metricPanels?.find((p) => p.id === panelId);
      seriesMap = panel?.seriesByProvider;
    } else {
      seriesMap = bench?.extras.series24h;
    }
  }
  const b = bench ?? aggregate;

  if (!seriesMap || Object.keys(seriesMap).length === 0) {
    return NextResponse.json(
      { error: "no_data_for_range", slug, range: rangeParam },
      { status: 404, headers: { "cache-control": "public, s-maxage=60" } },
    );
  }

  // Timestamps are not persisted with the series — reconstruct from the
  // Prom window. Series are DENSE (one slot per query_range evaluation
  // step, null where Prom had no sample), so the grid spans the full
  // window: timestamps[0] = now - window, last = now. Values with nulls
  // stay index-aligned with this array; consumers see the outage as
  // null slots instead of a silently shifted X-axis.
  const { windowMs, points: targetPoints } = RANGE_CONFIG[rangeParam];
  const firstSeries = Object.values(seriesMap).find((arr) => arr.length > 0);
  const actualPoints = firstSeries?.length ?? targetPoints;
  const endMs = Date.now();
  const startMs = endMs - windowMs;
  const stepMs = windowMs / Math.max(1, actualPoints - 1);
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
