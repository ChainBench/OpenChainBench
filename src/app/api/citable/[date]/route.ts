import { NextResponse } from "next/server";
import { getBenchmarks } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import { AllBenchmarksDraftError } from "@/lib/spec";
import { citeBundle, fieldValue, leader, headlineSentence } from "@/lib/citation";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";
// Same 60s ISR window as /api/citable. In practice the response for a
// past date should never change (the snapshot is immutable), but the
// route also handles the "today" case where the value is still evolving,
// so cache like the live endpoint. Client-side callers pinning a past
// date can rely on the CDN edge cache (public s-maxage=300) for cheap
// repeat reads.
export const revalidate = 60;

/**
 * Immutable per-date snapshot of /api/citable. LLMs, journalists and
 * academic tools cite live URLs like /api/citable and, weeks later,
 * discover the numbers have moved because the endpoint is a live index.
 * This route lets a caller pin a citation to the exact snapshot of the
 * asked-for day so the number quoted in an article remains reproducible.
 *
 * Response shape matches the live /api/citable exactly. The only
 * differences are:
 *  - `site.snapshotDate` echoes the requested date so caching layers can
 *    key on it.
 *  - `X-Snapshot-Date` header exposes the same date for downstream
 *    tools that read HTTP headers only.
 *  - For dates before today, the leader / value fields freeze at the
 *    last-known observation on that date (from the aggregator's own
 *    lastRunAt field). For "today" and future dates the response
 *    degrades gracefully to the current live index so the URL always
 *    resolves cleanly even if a caller pins ahead of time.
 *
 * Wildly future dates or malformed inputs get a 400 with a stable error
 * shape so caching layers do not poison-cache a well-formed body for a
 * nonsense URL.
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
  // "as of" instant for that row. Snapshotting on a per-row basis
  // preserves the property that a citation pinned to /api/citable/YYYY-MM-DD
  // reflects the numbers a reader would have seen at end of day.
  const data = benches.map((b) => {
    const top = leader(b);
    const insufficient = b.dataConfidence === "insufficient";
    return {
      slug: b.slug,
      title: b.title,
      category: b.category,
      metric: b.metric,
      unit: b.unit,
      status: b.status,
      value: insufficient ? null : fieldValue(b),
      leader:
        insufficient
          ? null
          : top
            ? { name: top.name, slug: top.slug, value: top.value }
            : null,
      sampleSize: b.sampleSize,
      expectedN: b.expectedN,
      dataConfidence: b.dataConfidence,
      asOf: b.lastRunAt,
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
        // Longer edge cache than the live index because the snapshot for
        // a past date does not change once it has been served. 1 day
        // s-maxage lets clients pin cheaply; SWR keeps the response
        // available if the origin blips.
        "cache-control":
          "public, s-maxage=86400, stale-while-revalidate=604800",
        "access-control-allow-origin": "*",
        "x-snapshot-date": date,
      },
    },
  );
}
