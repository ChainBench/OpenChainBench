import { NextResponse } from "next/server";
import { getBenchmark } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import {
  citationQuote,
  citeBundle,
  fieldValue,
  headlineSentence,
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

  const top = leader(b);
  const insufficient = b.dataConfidence === "insufficient";
  const payload = {
    slug: b.slug,
    title: b.title,
    subtitle: b.subtitle,
    category: b.category,
    metric: b.metric,
    unit: b.unit,
    status: b.status,
    higherIsBetter: b.higherIsBetter,
    // Aggregate is "insufficient" (median per-provider sample health
    // below 10 percent of expected_n): refuse to publish a value or
    // leader; the headline is rewritten by headlineSentence so the
    // agent / journalist reads "insufficient data" instead of quoting
    // a number drawn from undersized samples.
    value: insufficient ? null : fieldValue(b),
    leader: insufficient ? null : top,
    rankings: b.results
      .filter((r) => r.ms.p50 > 0)
      // Drop "insufficient" rows from the machine-readable ranking too:
      // a row that the page hides from the leaderboard must not surface
      // here either.
      .filter((r) => r.dataConfidence !== "insufficient")
      .sort((a, c) => (b.higherIsBetter ? c.ms.p50 - a.ms.p50 : a.ms.p50 - c.ms.p50))
      .map((r) => ({
        name: r.name,
        slug: r.slug,
        ms: r.ms,
        successRate: r.successRate,
        sampleSize: r.sampleSize,
        sampleHealth: r.sampleHealth,
        dataConfidence: r.dataConfidence,
      })),
    sparkline: sparklineFor(b, top?.slug),
    sampleSize: b.sampleSize,
    expectedN: b.expectedN,
    dataConfidence: b.dataConfidence,
    asOf: b.lastRunAt,
    headline: headlineSentence(b),
    quote: citationQuote(b, SITE.url),
    cite: citeBundle(b, SITE.url),
    pageUrl: `${SITE.url}/benchmarks/${b.slug}`,
    ogImage: `${SITE.url}/api/og/${b.slug}`,
    source: b.source,
    methodology: b.methodology,
    license: "CC-BY-4.0",
  };

  return NextResponse.json(payload, {
    headers: {
      "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
      "access-control-allow-origin": "*",
    },
  });
}
