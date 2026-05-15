import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge middleware. Two jobs:
 *
 * 1. **Cache-key normalisation** on public read-only API routes that
 *    don't use query params. Vercel keys the edge cache on the full URL,
 *    so `?cb=1`, `?cb=2`, … each create a new cache entry and bypass
 *    the s-maxage coalescing. Without this, an attacker hitting unique
 *    query strings forces every request to hit the origin function and
 *    fan out to Prom. We redirect (308) such requests to the canonical
 *    path so the edge cache key never includes the query string.
 *
 * 2. **(future)** any cross-route concerns — kept lightweight.
 */

const CANONICAL_NO_QUERY = new Set([
  "/api/citable",
  "/api/llm-context",
  "/api/freshness",
  "/api/openapi.json",
]);

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (search && CANONICAL_NO_QUERY.has(pathname)) {
    const canonical = req.nextUrl.clone();
    canonical.search = "";
    return NextResponse.redirect(canonical, 308);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/citable", "/api/llm-context", "/api/freshness", "/api/openapi.json"],
};
