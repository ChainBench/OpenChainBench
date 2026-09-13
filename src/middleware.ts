import { NextResponse, type NextRequest } from "next/server";

// Single source of truth for prod-excluded bench slugs. Lives in its
// own module (not here) so the spec loader and the materialize worker
// can import it without pulling next/server. Re-exported for the
// sitemap, which historically imports it from "@/middleware".
import {
  REMOVED_ANSWER_SLUGS,
  REMOVED_BENCH_SLUGS,
  REMOVED_PRODUCT_SLUGS,
} from "@/lib/removed-benches";
export { REMOVED_BENCH_SLUGS };

/**
 * Two jobs, both keyed so the matcher only admits the requests that
 * need them: 308 for mixed-case URLs, 410 Gone for retired URLs on
 * production. The matcher is a regex for the former and the literal
 * list of dead paths for the latter, so canonical lowercase traffic to
 * live pages never invokes the middleware (edge middleware invocations
 * are billed per call; before this change roughly half of all site
 * requests paid for one).
 *
 * Everything else that used to live here moved to where it is free or
 * already paid for:
 *   - renamed benches (301): `redirects()` in next.config.ts, served
 *     from the routing layer without a function;
 *   - `/compare/<a>-vs-<b>` alphabetical canonical: the compare page
 *     already redirected non-canonical pairs, the middleware copy was
 *     redundant;
 *   - query stripping on the canonical API routes: inside those
 *     route handlers (they run a function anyway).
 *
 * The matcher must be a literal (Next evaluates it statically), so the
 * list below is generated from the sets in removed-benches.ts and
 * pinned by src/middleware.test.ts: adding a slug to a set without
 * adding its path here fails the test.
 */
const BENCH_PATH = /^\/benchmarks\/([a-z0-9][a-z0-9-]{0,79})\/?$/;
const ANSWER_PATH = /^\/answers\/([a-z0-9][a-z0-9-]{0,79})\/?$/;
const PRODUCT_PATH = /^\/products\/([a-z0-9][a-z0-9-]{0,79})\/?$/;

const GONE_BENCH = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>410 Gone</title><meta name="robots" content="noindex"></head><body><h1>410 Gone</h1><p>This benchmark has been retired. See the <a href="/benchmarks">current catalog</a>.</p></body></html>`;
const GONE_PRODUCT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>410 Gone</title><meta name="robots" content="noindex"></head><body><h1>410 Gone</h1><p>This product page has been retired because the provider is no longer measured in any active benchmark. See the <a href="/products">current catalog</a>.</p></body></html>`;

function gone(body: string): NextResponse {
  return new NextResponse(body, {
    status: 410,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Case normalisation. `/products/Alchemy` used to serve 200 with the
  // mixed-case URL while the canonical pointed at the lowercase form,
  // and Google indexed both. It has to happen here: Next resolves the
  // ISR cache case-insensitively, so a redirect inside the page never
  // runs for a URL whose lowercase twin is already cached. The matcher
  // below only admits paths containing an uppercase letter, so the
  // lowercase (canonical) traffic never invokes the middleware.
  if (pathname !== pathname.toLowerCase()) {
    const url = req.nextUrl.clone();
    url.pathname = pathname.toLowerCase();
    return NextResponse.redirect(url, 308);
  }

  // Only fires on production so staging keeps rendering held-back
  // benches for review (REMOVED_BENCH_SLUGS doubles as the staging
  // pipeline). Direct URL hits on prod get the SEO-correct 410.
  if (process.env.VERCEL_ENV !== "production") return NextResponse.next();

  const m = pathname.match(BENCH_PATH);
  const a = pathname.match(ANSWER_PATH);
  if (
    (m && REMOVED_BENCH_SLUGS.has(m[1])) ||
    (a && REMOVED_ANSWER_SLUGS.has(a[1]))
  ) {
    return gone(GONE_BENCH);
  }
  const p = pathname.match(PRODUCT_PATH);
  if (p && REMOVED_PRODUCT_SLUGS.has(p[1])) {
    return gone(GONE_PRODUCT);
  }
  return NextResponse.next();
}

// Generated from removed-benches.ts; see the header comment and
// src/middleware.test.ts. Keep sorted by section, one path per line.
export const config = {
  matcher: [
    // Mixed-case URLs under the four canonical sections (see the case
    // block above). The custom regex admits a segment only when it
    // contains an uppercase letter; the (?-i) is not available, so the
    // test in middleware.test.ts pins that lowercase paths do not match.
    "/benchmarks/:slug([^/]*[A-Z][^/]*)",
    "/products/:slug([^/]*[A-Z][^/]*)",
    "/answers/:slug([^/]*[A-Z][^/]*)",
    "/compare/:slug([^/]*[A-Z][^/]*)",
    "/Benchmarks/:path*",
    "/Products/:path*",
    "/Answers/:path*",
    "/Compare/:path*",
    "/benchmarks/bridge-revenue",
    "/benchmarks/solana-tx-landing-latency",
    "/benchmarks/indexer-latency",
    "/benchmarks/oracle-freshness",
    "/benchmarks/tokenized-stock-arb-latency",
    "/benchmarks/token-trade-coverage",
    "/benchmarks/cross-chain-messaging-latency",
    "/benchmarks/solana-dex-quote-latency",
    "/benchmarks/explorer-chain-coverage",
    "/benchmarks/portfolio-chain-coverage",
    "/benchmarks/pm-data-freshness",
    "/benchmarks/perp-open-interest",
    "/benchmarks/pm-fee-comparison",
    "/benchmarks/pm-geographic-access",
    "/benchmarks/polymarket-resolution-delay",
    "/benchmarks/indexing-freshness",
    "/answers/which-evm-aggregator-has-the-fastest-quote",
    "/answers/which-solana-rpc-lands-the-most-transactions",
    "/answers/which-solana-dex-aggregator-is-the-fastest",
    "/answers/which-prediction-market-data-api-is-the-freshest",
    "/products/bitquery",
    "/products/goldrush",
    "/products/zerion",
    "/products/routescan",
  ],
};
