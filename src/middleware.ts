import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge middleware. Four jobs:
 *
 * 1. **Cache-key normalisation** on public read-only API routes that
 *    don't use query params. Vercel keys the edge cache on the full URL,
 *    so `?cb=1`, `?cb=2`, … each create a new cache entry and bypass
 *    the s-maxage coalescing. Without this, an attacker hitting unique
 *    query strings forces every request to hit the origin function and
 *    fan out to Prom. We redirect (308) such requests to the canonical
 *    path so the edge cache key never includes the query string.
 *
 * 2. **410 Gone for benches removed from production.** Some benches live
 *    on dev / staging only (bridge-revenue, evm-quote-latency, etc.).
 *    On prod they hit `notFound()` and return a 404. Sustained 404 on
 *    previously-indexed URLs gets read as a soft-404 signal that bleeds
 *    into surrounding bench rankings, likely the dominant driver of the
 *    recent brand-search collapse. Returning 410 explicitly tells Google
 *    "this URL is gone for good", and the cluster recovers.
 *
 *    Only fires on production (`VERCEL_ENV === "production"`) so that
 *    staging / preview / local dev still render the bench pages from
 *    their YAML files normally.
 *
 * 3. **Canonical-order redirect on /compare/<a>-vs-<b>.** Pair pages
 *    have a single canonical URL: the alphabetical ordering of the two
 *    provider slugs. Without this, `/compare/base-vs-arbitrum` and
 *    `/compare/arbitrum-vs-base` both 200 with separate streamed
 *    Suspense fallbacks, which Google indexes as two empty shells of
 *    the same comparison. The page component also calls `redirect()`
 *    on non-canonical slugs but that fires after the loading.tsx
 *    boundary has streamed its skeleton, so the response goes out as
 *    200 with the skeleton HTML and the homepage metadata. Doing it at
 *    the edge here short-circuits before any render starts.
 *
 * 4. **(future)** any cross-route concerns. Kept lightweight.
 */

const CANONICAL_NO_QUERY = new Set([
  "/api/citable",
  "/api/llm-context",
  "/api/freshness",
  "/api/openapi.json",
]);

/**
 * Bench slugs that existed on production at some point and were later
 * removed (or that were never on production but their dev path could
 * have leaked into the index via staging crawl). 410 on prod, normal
 * render on dev / preview.
 *
 * Also re-exported so the sitemap can exclude these routes on prod;
 * emitting them advertises URLs that middleware immediately 410s,
 * which fails the sitemap-smoke gate and rolls back every deploy.
 */
export const REMOVED_BENCH_SLUGS = new Set([
  "bridge-revenue",
  "evm-quote-latency",
]);

const BENCH_PATH = /^\/benchmarks\/([a-z0-9][a-z0-9-]{0,79})\/?$/;
// `/compare/<a>-vs-<b>` with both sides as standard provider slug
// shapes (lowercase alphanumeric + hyphens). The `-vs-` delimiter is
// matched literally; provider slugs themselves can contain hyphens
// (e.g. `helius-sender`, `phantom-perps`), so split on the first
// occurrence at parse time, not on every `-`.
const COMPARE_PATH = /^\/compare\/([a-z0-9][a-z0-9-]{0,79})\/?$/;

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (search && CANONICAL_NO_QUERY.has(pathname)) {
    const canonical = req.nextUrl.clone();
    canonical.search = "";
    return NextResponse.redirect(canonical, 308);
  }

  if (process.env.VERCEL_ENV === "production") {
    const m = pathname.match(BENCH_PATH);
    if (m && REMOVED_BENCH_SLUGS.has(m[1])) {
      return new NextResponse(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>410 Gone</title><meta name="robots" content="noindex"></head><body><h1>410 Gone</h1><p>This benchmark has been retired. See the <a href="/benchmarks">current catalog</a>.</p></body></html>`,
        { status: 410, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
  }

  const compareMatch = pathname.match(COMPARE_PATH);
  if (compareMatch) {
    const canonical = canonicalComparePath(compareMatch[1]);
    if (canonical && canonical !== compareMatch[1]) {
      const url = req.nextUrl.clone();
      url.pathname = `/compare/${canonical}`;
      return NextResponse.redirect(url, 308);
    }
  }

  return NextResponse.next();
}

/** Returns the alphabetical canonical form of a `<a>-vs-<b>` slug, or
 *  null when the slug isn't a valid pair shape. When the slug is already
 *  canonical the return value equals the input. */
function canonicalComparePath(slug: string): string | null {
  const idx = slug.indexOf("-vs-");
  if (idx <= 0) return null;
  const a = slug.slice(0, idx);
  const b = slug.slice(idx + "-vs-".length);
  if (!a || !b || a === b) return null;
  const [first, second] = [a, b].sort();
  return `${first}-vs-${second}`;
}

export const config = {
  matcher: [
    "/api/citable",
    "/api/llm-context",
    "/api/freshness",
    "/api/openapi.json",
    "/benchmarks/:slug*",
    "/compare/:slug*",
  ],
};
