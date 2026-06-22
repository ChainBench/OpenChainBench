import { NextResponse } from "next/server";
import { getBenchmark } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import {
  citationQuote,
  fieldValue,
  headlineSentence,
  isInsufficient,
  leader,
  sparklineFor,
} from "@/lib/citation";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { SLUG_RE } from "@/lib/slug";

export const runtime = "nodejs";
export const revalidate = 60;


/**
 * Single benchmark as a citable atomic unit. Designed to fit into one
 * agent tool call: ranked providers, sparkline, methodology link,
 * pre-formatted attribution string, and stable citation URL.
 *
 * Status field semantics:
 *   "live"          - usable measurement, leader / value populated.
 *   "draft"         - spec author has not published (editorialStatus draft).
 *   "insufficient"  - editorially live but the harness has no usable
 *                     sample yet (every provider p50 = 0, or runtime
 *                     status flipped to draft mid-cycle). value, leader
 *                     and rankings p50 are nulled so a consumer cannot
 *                     accidentally cite a fabricated winner. The shape
 *                     of the response is preserved.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const r = rateLimit(clientKey(req, "stat"), 60, 60, req);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  const { slug } = await params;
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400 });
  }
  const b = await getBenchmark(slug);
  if (!b || b.editorialStatus !== "live") {
    return NextResponse.json(
      { error: "unknown_slug", slug },
      {
        status: 404,
        headers: { "cache-control": "public, s-maxage=60" },
      },
    );
  }

  const insufficient = isInsufficient(b);
  const top = insufficient ? null : leader(b);
  const value = insufficient ? null : fieldValue(b);
  // Status surfaced to consumers: "insufficient" wins over the raw
  // runtime "live" flag when the predicate fires, so /api/stat stops
  // claiming live data for a bench whose harness has nothing to show.
  const status: "live" | "draft" | "insufficient" = insufficient
    ? "insufficient"
    : b.status;

  // Rankings: when insufficient we still return one entry per provider
  // (shape preserved for any consumer that diff-tracks the provider set)
  // but every p50 is nulled to drive home that no comparison is possible.
  const rankings = insufficient
    ? b.results.map((r) => ({
        name: r.name,
        slug: r.slug,
        type: r.type ?? null,
        layer: r.layer ?? null,
        tag: r.tag ?? null,
        ms: { p50: null, p90: null, p99: null, mean: null },
        successRate: r.successRate,
        sampleSize: r.sampleSize ?? null,
      }))
    : b.results
        .filter((r) => r.ms.p50 > 0)
        .sort((a, c) =>
          b.higherIsBetter ? c.ms.p50 - a.ms.p50 : a.ms.p50 - c.ms.p50,
        )
        .map((r) => ({
          name: r.name,
          slug: r.slug,
          type: r.type ?? null,
          layer: r.layer ?? null,
          tag: r.tag ?? null,
          ms: r.ms,
          successRate: r.successRate,
          sampleSize: r.sampleSize,
        }));

  const payload = {
    slug: b.slug,
    title: b.title,
    subtitle: b.subtitle,
    category: b.category,
    metric: b.metric,
    unit: b.unit,
    status,
    higherIsBetter: b.higherIsBetter,
    value,
    leader: top,
    rankings,
    sparkline: insufficient ? [] : sparklineFor(b, top?.slug),
    sampleSize: insufficient ? 0 : b.sampleSize,
    asOf: b.lastRunAt,
    headline: headlineSentence(b),
    quote: citationQuote(b, SITE.url),
    pageUrl: `${SITE.url}/benchmarks/${b.slug}`,
    ogImage: `${SITE.url}/api/og/${b.slug}`,
    source: b.source,
    methodology: b.methodology,
    license: "CC-BY-4.0",
    // Per-chain leader / worst. Empty for benches without a chain
    // dimension. Used by the HF publisher to populate chain_leaders.
    // Insufficient benches null both since the underlying rankings
    // are not citable.
    bestPerChain: insufficient ? null : (b.bestPerChain ?? null),
    worstPerChain: insufficient ? null : (b.worstPerChain ?? null),
  };

  return NextResponse.json(payload, {
    headers: {
      "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
      "access-control-allow-origin": "*",
    },
  });
}
