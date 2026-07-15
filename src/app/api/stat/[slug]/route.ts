import { NextResponse } from "next/server";
import { getBenchmark } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import {
  citableAsOf,
  citationQuote,
  citeBundle,
  fieldValue,
  headlineSentence,
  leader,
  rankedCandidates,
  sparklineFor,
} from "@/lib/citation";
import { valueInDeclaredUnit } from "@/lib/format";
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
  // Dimension query params (?chain=, ?region=, ?kind=, ?venue=) mirror
  // the same client-side selector on the bench page, so a citer asking
  // "fastest ethereum us-east RPC" gets the per cell leader instead of
  // the cross chain aggregate. Values pass through to the loader
  // unchanged. An unknown value (`?chain=nonexistent`) does NOT fall
  // back to the unfiltered aggregate — the loader returns undefined and
  // the route below 404s. That is intentional: silently substituting
  // the aggregate for a mistyped filter would make citers cite the
  // wrong number without knowing.
  const url = new URL(req.url);
  const filters: {
    chain?: string;
    region?: string;
    kind?: string;
    venue?: string;
  } = {};
  const chainParam = url.searchParams.get("chain");
  const regionParam = url.searchParams.get("region");
  const kindParam = url.searchParams.get("kind");
  const venueParam = url.searchParams.get("venue");
  if (chainParam && chainParam !== "all") filters.chain = chainParam;
  if (regionParam && regionParam !== "all") filters.region = regionParam;
  if (kindParam && kindParam !== "all") filters.kind = kindParam;
  if (venueParam && venueParam !== "all") filters.venue = venueParam;
  const b = await getBenchmark(slug, filters);
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
  // Publish value + leader.value in the declared unit. Unit "s" benches
  // store ms internally (fmtUnit convention); do not leak that here.
  const raw = insufficient ? null : fieldValue(b);
  const payload = {
    slug: b.slug,
    title: b.title,
    subtitle: b.subtitle,
    category: b.category,
    metric: b.metric,
    unit: b.unit,
    status: b.status,
    higherIsBetter: b.higherIsBetter,
    // Echo the applied dimension filter so a citer can verify which
    // cell (chain / region / kind / venue) their answer covers.
    // Missing key = "all" for that dimension.
    filters:
      Object.keys(filters).length > 0 ? filters : null,
    // Aggregate is "insufficient" (median per-provider sample health
    // below 10 percent of expected_n): refuse to publish a value or
    // leader; the headline is rewritten by headlineSentence so the
    // agent / journalist reads "insufficient data" instead of quoting
    // a number drawn from undersized samples.
    value: raw == null ? null : valueInDeclaredUnit(raw, b.unit),
    leader:
      insufficient || !top
        ? null
        : { ...top, value: valueInDeclaredUnit(top.value, b.unit) },
    // Shares `rankedCandidates` with `leader()` so `rankings[0]`
    // stays consistent with the `leader` field on the same JSON blob:
    // a document that names Etherscan as leader must not also list
    // Owlracle first here.
    rankings: rankedCandidates(b).map((r) => ({
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
    asOf: citableAsOf(b),
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
