import { NextResponse } from "next/server";
import { getBenchmark } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import {
  citableAsOf,
  citationQuote,
  benchPath,
  cohortSummaries,
  citeBundle,
  fieldValue,
  headlineSentence,
  leader,
  leaders,
  rankedCandidates,
  sparklineFor,
} from "@/lib/citation";
import { valueInDeclaredUnit } from "@/lib/format";
import { dataAgeHours, displayResults, isStaleBench } from "@/lib/provider-filters";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { SLUG_RE } from "@/lib/slug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


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
    tier?: string;
  } = {};
  const chainParam = url.searchParams.get("chain");
  const regionParam = url.searchParams.get("region");
  const kindParam = url.searchParams.get("kind");
  const venueParam = url.searchParams.get("venue");
  const tierParam = url.searchParams.get("tier");
  if (chainParam && chainParam !== "all") filters.chain = chainParam;
  if (regionParam && regionParam !== "all") filters.region = regionParam;
  if (kindParam && kindParam !== "all") filters.kind = kindParam;
  if (venueParam && venueParam !== "all") filters.venue = venueParam;
  // Tier is resolved against the declared values like the variant route:
  // an unknown tier must not build an empty cohort and answer from it.
  if (tierParam && tierParam !== "all") {
    const aggregate = await getBenchmark(slug);
    const known = aggregate?.dimensions?.tier?.find(
      (t) => t.value.toLowerCase() === tierParam.toLowerCase().trim(),
    );
    if (!known) {
      return NextResponse.json(
        { error: "unknown_tier", tier: tierParam },
        { status: 400, headers: { "cache-control": "public, s-maxage=60" } },
      );
    }
    // The headline tier is the aggregate itself (no variant blob exists
    // for it): resolve it to no filter like the variant route does.
    const headline = aggregate?.aggregateFilters?.tier ?? aggregate?.dimensions?.tier?.[0]?.value;
    if (known.value !== headline) filters.tier = known.value;
  }
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
    // Access cohorts of a tier-dimensioned bench (chain RPC pages: the
    // public endpoints and the private, API-key providers), each with its
    // own leader, sentence, rankings and URL, ranked apart. Present on
    // the headline record so one call answers both questions; the
    // record's own value/leader/rankings describe the requested cohort.
    ...(cohortSummaries(b, SITE.url).length > 0 ? { cohorts: cohortSummaries(b, SITE.url) } : {}),
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
    // Every provider tied with the leader on the displayed figure;
    // `leader` stays leaders[0] for consumers that predate the field.
    leaders: insufficient
      ? []
      : leaders(b).map((l) => ({ ...l, value: valueInDeclaredUnit(l.value, b.unit) })),
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
    // How old the data is, so a citer sees a paused measurement before
    // quoting it (six chain RPC pages served 11 to 34 day old numbers as
    // "live" on 2026-09-19). `measured` is the display cohort the page
    // counts; `rankings` keeps only rows above the citation success
    // floor, which is why the two can differ.
    freshness: {
      asOf: b.lastRunAt ?? null,
      ageHours: Number.isFinite(dataAgeHours(b)) ? Math.round(dataAgeHours(b) * 10) / 10 : null,
      stale: isStaleBench(b),
    },
    measured: displayResults(b.results).length,
    // The cohort `rankings` and `leader` describe (50 % success floor,
    // rank and sample gates); `measured` is the wider display cohort.
    ranked: rankedCandidates(b).length,
    headline: headlineSentence(b),
    quote: citationQuote(b, SITE.url),
    cite: citeBundle(b, SITE.url),
    pageUrl: `${SITE.url}${benchPath(b)}`,
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
