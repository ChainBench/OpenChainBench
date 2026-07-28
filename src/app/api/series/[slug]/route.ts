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
import { Prometheus } from "@/lib/prometheus";

function escapePromLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

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
    range: "7d" | "30d" | "90d" | "1y",
    chain: string | undefined,
    region: string | undefined,
    kind: string | undefined,
    venue: string | undefined,
    panelId: string | undefined,
  ): Promise<Record<string, (number | null)[]> | null> => {
    // ── Standard ranges (7d / 30d): blob → Redis → live build ──────────
    if (range === "7d" || range === "30d") {
      const sig = filterSig({ chain, region, kind, venue });
      const stored =
        (await loadSnapshotFromBlob(slug, sig)) ??
        (await readMaterialized(slug, sig));
      if (stored) {
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
      const specs = await loadSpecsUncached();
      const spec = specs.find((s) => s.slug === slug);
      if (!spec || spec.status !== "live") return null;

      if (panelId) {
        // Targeted Prom query for just this panel's metric instead of the
        // full specToBenchmark (which fires O(providers × panels) queries
        // and times out on large benches like hyperliquid-frontends).
        const panel = spec.metric_panels?.find((mp) => mp.id === panelId);
        if (!panel) return null;
        const promUrl = spec.prometheus?.url ?? process.env.PROMETHEUS_URL;
        if (!promUrl) return null;
        const prom = new Prometheus(promUrl);
        const windowSec = range === "7d" ? 7 * 86_400 : 30 * 86_400;
        const numPoints = range === "7d" ? 84 : 60;
        const labelKey = panel.label_key ?? "builder";
        const result: Record<string, (number | null)[]> = {};
        await Promise.all(
          spec.providers.map(async (p) => {
            const sel = `${labelKey}="${escapePromLabelValue(p.slug)}"`;
            const q = panel.metric.includes("{")
              ? panel.metric.replace("{", `{${sel},`)
              : `${panel.metric}{${sel}}`;
            const s = await prom.series(q, windowSec, numPoints);
            if (s && s.length > 0) result[p.slug] = s;
          }),
        );
        return Object.keys(result).length > 0 ? result : null;
      }

      const b = await specToBenchmark(spec, { chain, region, kind, venue });
      return (range === "7d" ? b.extras.series7d : b.extras.series30d) ?? null;
    }

    // ── Extended ranges (90d / 1y): query Prom directly ─────────────────
    // No blobs exist for these windows. Prometheus retention is 365d so
    // the data is there; we just need to ask with a wider query_range.
    // unstable_cache keeps the result warm for 5 min so cold-start cost
    // (many concurrent series queries) is paid at most once per cache window.
    const specs = await loadSpecsUncached();
    const spec = specs.find((s) => s.slug === slug);
    if (!spec || spec.status !== "live") return null;

    const promUrl = spec.prometheus?.url ?? process.env.PROMETHEUS_URL;
    if (!promUrl) return null;
    const prom = new Prometheus(promUrl);

    const windowSec = range === "90d" ? 90 * 86_400 : 365 * 86_400;
    // ~1 point per day for 90d, ~3 days per point for 1y — dense enough
    // for a smooth bar-chart race without blowing Prom step budgets.
    const numPoints = range === "90d" ? 90 : 120;

    const result: Record<string, (number | null)[]> = {};
    await Promise.all(
      spec.providers.map(async (p) => {
        let q: string | undefined;
        if (panelId) {
          const panel = spec.metric_panels?.find((mp) => mp.id === panelId);
          if (!panel) return;
          const labelKey = panel.label_key ?? "builder";
          const sel = `${labelKey}="${escapePromLabelValue(p.slug)}"`;
          q = panel.metric.includes("{")
            ? panel.metric.replace("{", `{${sel},`)
            : `${panel.metric}{${sel}}`;
        } else {
          q = p.queries?.series;
        }
        if (!q) return;
        const s = await prom.series(q, windowSec, numPoints);
        if (s && s.length > 0) result[p.slug] = s;
      }),
    );

    return Object.keys(result).length > 0 ? result : null;
  },
  // v7: targeted Prom fallback for panel 7d/30d misses (avoids specToBenchmark O(providers×panels)).
  ["series-by-range-v7"],
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
  "90d": { windowMs: 90 * 24 * 3600 * 1000, points: 90 },
  "1y": { windowMs: 365 * 24 * 3600 * 1000, points: 120 },
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

  // 24h is served from the slim cached Benchmark (cheap). 7d / 30d / 90d / 1y
  // come from the dedicated getSeriesMapCached above (Prom fan-out the
  // first time, then 5 min of free reads from unstable_cache). Loading
  // a 100-KB series map is cheap enough that we still need the row
  // metadata (name, color, logo) — fetch the cached bench for that
  // separately so its slim ~50 KB payload reuses the existing cache.
  let seriesMap: Record<string, (number | null)[]> | undefined | null;
  let bench;
  if (rangeParam !== "24h") {
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

  const rawProviders = b.results
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

  // When a panel is active, use its metadata (label / unit / higherIsBetter)
  // instead of the bench-level values so the video renderer labels the y-axis
  // and sorts the race correctly for companion metrics.
  const activePanelMeta = panelId
    ? b.metricPanels?.find((p) => p.id === panelId)
    : undefined;
  const sourceUnit = activePanelMeta?.unit ?? b.unit;

  // Normalize OCB internal units to display-friendly ones for the video
  // renderer, which appends the unit string as a label and has no knowledge
  // of OCB's internal conventions:
  //   "bps" = stored in basis points, site displays as % (÷100) → send "pct" + divide values
  //   "s"   = stored in milliseconds, site displays as seconds   → send "s"  + divide values
  //   "pct", "bp", "usd", "count", …                            → pass through unchanged
  let displayUnit = sourceUnit;
  const providers = rawProviders.map((p) => ({ ...p }));
  if (sourceUnit === "bps") {
    displayUnit = "pct";
    for (const p of providers) {
      p.values = p.values.map((v) => (v == null ? null : v / 100));
    }
  } else if (sourceUnit === "s") {
    for (const p of providers) {
      p.values = p.values.map((v) => (v == null ? null : v / 1000));
    }
  }

  return NextResponse.json(
    {
      slug: b.slug,
      title: b.title,
      metric: activePanelMeta?.label ?? b.metric,
      unit: displayUnit,
      higherIsBetter: activePanelMeta?.higherIsBetter ?? b.higherIsBetter,
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
