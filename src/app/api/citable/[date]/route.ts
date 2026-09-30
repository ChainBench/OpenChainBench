import { NextResponse } from "next/server";
import { getBenchmarks } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import { AllBenchmarksDraftError } from "@/lib/spec";
import { citableAsOf, citeBundle, fieldValue, leader, headlineSentence } from "@/lib/citation";
import { valueInDeclaredUnit } from "@/lib/format";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";
// Deliberately NOT cached harder than a day, even though a dated
// snapshot looks immutable. It is not one yet: see the note on the
// response headers at the bottom of this file. Measured on prod
// 2026-09-30, /api/citable/2026-01-15 returned all 225 rows byte-equal
// to the live /api/citable, each carrying asOf 2026-09-30. Until the
// route reads a real per-date store, an immutable window would freeze
// one arbitrary day's live reading under a past date's label, forever.
export const dynamic = "force-dynamic";

/**
 * Per-date view of /api/citable. INTENDED as an immutable snapshot, and
 * not one yet: read the KNOWN GAP below before trusting the shape.
 *
 * The motivation is real. LLMs, journalists and academic tools cite live
 * URLs like /api/citable and, weeks later, discover the numbers have
 * moved because the endpoint is a live index. The intent of this route
 * is to let a caller pin a citation to the snapshot of the asked-for day
 * so the number quoted in an article stays reproducible. What it
 * currently returns is the live index with the requested date attached.
 *
 * Response shape matches the live /api/citable exactly. The only
 * differences are:
 *  - `site.snapshotDate` echoes the requested date so caching layers can
 *    key on it.
 *  - `X-Snapshot-Date` header exposes the same date for downstream
 *    tools that read HTTP headers only.
 *  - KNOWN GAP: the per-date freeze described below is not implemented.
 *    The intent is that a date before today returns the values as of
 *    that date; what the handler actually does is read the current
 *    benchmarks and relabel them with the requested date. Every row's
 *    own `asOf` is honest (it carries the bench's real lastRunAt, which
 *    for a past date will read as today), so a consumer that checks
 *    `asOf` is not misled, but one that trusts the URL is. Closing this
 *    needs a per-date store the aggregator does not write yet.
 *
 * Malformed inputs, and dates outside 2025-2100, get a 400 with a
 * stable error shape so caching layers do not poison-cache a well-formed
 * body for a nonsense URL. Note that "wildly future" is not among them:
 * the check below is a calendar-range check, so /api/citable/2100-12-31
 * answers 200 with today's benchmarks, snapshotDate 2100-12-31,
 * x-snapshot-date, CORS open and a day at the edge. Tolerating a future
 * date was deliberate (a caller pinning ahead of time still resolves),
 * but combined with the KNOWN GAP it is the relabelling at its worst.
 * Whether a future date should 400 instead is an API decision for the
 * per-date store work, not something to change underneath callers here.
 */
function badRequest(reason: string): NextResponse {
  return NextResponse.json(
    { error: "bad_request", reason },
    {
      status: 400,
      headers: {
        "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
        "access-control-allow-origin": "*",
      },
    },
  );
}

function unavailable(): NextResponse {
  return NextResponse.json(
    { error: "benchmarks_unavailable", retryAfterSec: 60 },
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "retry-after": "60",
        "access-control-allow-origin": "*",
      },
    },
  );
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ date: string }> },
) {
  const r = rateLimit(clientKey(req, "citable-date"), 60, 60, req);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  const { date } = await params;
  const m = ISO_DATE.exec(date);
  if (!m) {
    return badRequest(
      "date must be an ISO 8601 calendar date in the form YYYY-MM-DD",
    );
  }
  // Reject dates that Date.parse would happily accept but that are
  // nonsensical for a bench snapshot (year before 2025 predates
  // OpenChainBench's public existence, month or day out of range).
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 2025 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return badRequest("date is out of range");
  }
  const requested = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(requested.getTime())) return badRequest("invalid date");

  let benches;
  try {
    benches = (await getBenchmarks()).filter(
      (b) => b.editorialStatus === "live",
    );
  } catch (err) {
    if (err instanceof AllBenchmarksDraftError) return unavailable();
    throw err;
  }

  // Same shape as /api/citable to keep downstream consumers zero-effort
  // to port. Every citable field is the value as of the last live
  // observation captured in the bench (b.lastRunAt), which is the honest
  // "as of" instant for that row, and that is the whole of what this loop
  // does: `date` is not consulted here or anywhere below it. It does NOT
  // preserve the property that a citation pinned to
  // /api/citable/YYYY-MM-DD reflects the numbers a reader would have seen
  // at end of day; the KNOWN GAP in the header block is exactly this.
  const data = benches.map((b) => {
    const top = leader(b);
    const insufficient = b.dataConfidence === "insufficient";
    // `value` and `leader.value` are published in the declared `unit`.
    // Latency benches with unit "s" store ms internally (fmtUnit
    // convention); valueInDeclaredUnit converts so a snapshot never
    // claims 627 seconds for a 627 ms head lag. Same conversion as
    // the live /api/citable route; missing here caused sub-1 unit
    // values to leak through as their internal ms representation.
    const raw = insufficient ? null : fieldValue(b);
    return {
      slug: b.slug,
      title: b.title,
      category: b.category,
      metric: b.metric,
      unit: b.unit,
      status: b.status,
      value: raw == null ? null : valueInDeclaredUnit(raw, b.unit),
      leader:
        insufficient
          ? null
          : top
            ? {
                name: top.name,
                slug: top.slug,
                value: valueInDeclaredUnit(top.value, b.unit),
              }
            : null,
      sampleSize: b.sampleSize,
      expectedN: b.expectedN,
      dataConfidence: b.dataConfidence,
      asOf: citableAsOf(b),
      headline: headlineSentence(b),
      url: `${SITE.url}/benchmarks/${b.slug}`,
      api: `${SITE.url}/api/stat/${b.slug}`,
      ogImage: `${SITE.url}/api/og/${b.slug}`,
      source: b.source,
      license: "CC-BY-4.0",
      cite: citeBundle(b, SITE.url),
    };
  });

  return NextResponse.json(
    {
      site: {
        name: SITE.name,
        url: SITE.url,
        license: "CC-BY-4.0",
        snapshotDate: date,
      },
      count: data.length,
      benchmarks: data,
    },
    {
      headers: {
        // A day, not `immutable`. The natural window for a dated
        // snapshot is a year, and that is where this should land once
        // the KNOWN GAP above is closed. While the body is really the
        // live index under a past label, a year-long entry would pin
        // one scrape's numbers to that date permanently; a day means
        // the mislabelling at least tracks the live figure. Do not
        // lengthen this before the per-date store exists.
        "cache-control":
          "public, s-maxage=86400, stale-while-revalidate=604800",
        "access-control-allow-origin": "*",
        "x-snapshot-date": date,
      },
    },
  );
}
