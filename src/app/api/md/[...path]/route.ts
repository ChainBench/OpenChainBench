import { NextResponse, type NextRequest } from "next/server";
import { getBenchmark } from "@/data/benchmarks";
import { getProvider } from "@/lib/providers";
import { fetchPerpCohort } from "@/lib/perp-stats";
import { captureServer } from "@/lib/analytics-server";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { benchMarkdown, perpsHubMarkdown, productMarkdown, rwaHubMarkdown } from "@/lib/markdown-views";

/**
 * Markdown views of a bench, the perps hub and a product page, at
 * /api/md/<the page's own path>. The header-conditioned rewrites in
 * next.config.ts (`rewrites()`, beforeFiles) send the HTML URL here when
 * the client's Accept header prefers text/markdown, so
 * `curl -H 'Accept: text/markdown' https://openchainbench.com/perps`
 * answers with the table an agent can read without a DOM.
 */
// Per read since 2026-09-24: this is the answer-engine surface, and the
// server-side analytics event exists to tell which agent reads what. A
// cached document (origin ISR, or the CDN behind s-maxage) would emit one
// event per cache fill and credit whichever family missed the cache, so
// the response is not cached anywhere and every read runs the handler,
// behind the same per-client limiter as /api/stat. The bench data it
// renders is itself read through the data cache; the per-request cost is
// the Markdown rendering and one PostHog POST after the response.
export const dynamic = "force-dynamic";

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** Errors answer in the format the client asked for, not JSON. */
function notFoundMd(what: string): NextResponse {
  return new NextResponse(`# Not found\n\n${what}\n`, {
    status: 404,
    headers: { "content-type": "text/markdown; charset=utf-8", vary: "Accept" },
  });
}

function markdown(text: string, canonical: string): NextResponse {
  return new NextResponse(text + "\n", {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store",
      link: `<${canonical}>; rel="canonical"`,
      vary: "Accept",
    },
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const r = rateLimit(clientKey(req, "md"), 60, 60, req);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);
  const { path } = await ctx.params;
  const res = await handle(path ?? []);
  // Only a served document counts as a read: a 404 on a junk path emits
  // nothing (review 2026-09-24).
  if (res.status === 200) {
    const [head, slug] = path ?? [];
    captureServer(req, "markdown_read", { path: `/${(path ?? []).join("/")}`, head, slug: slug ?? null });
  }
  return res;
}

async function handle(path: string[]): Promise<NextResponse> {
  const [head, slug, extra] = path;
  if (extra !== undefined) return notFoundMd("No Markdown view at this path.");

  if (head === "perps" && slug === undefined) {
    const cohort = await fetchPerpCohort();
    return markdown(perpsHubMarkdown(cohort), "/perps");
  }
  if (head === "rwa" && slug === undefined) {
    const slugs = ["rwa-yield-accuracy", "usdy-nav-basis", "tokenized-stock-peg", "xstocks-peg", "tokenized-stock-weekend-drift", "rwa-solana-depth"];
    const benches = (await Promise.all(slugs.map((s) => getBenchmark(s)))).filter((b): b is NonNullable<typeof b> => !!b);
    return markdown(rwaHubMarkdown(benches), "/rwa");
  }
  if (head === "benchmarks" && slug && SLUG.test(slug)) {
    // Same rule as the HTML page (src/app/benchmarks/[slug]/page.tsx): a
    // bench exists or it does not; editorialStatus only picks robots there.
    const b = await getBenchmark(slug);
    if (!b) return notFoundMd(`No benchmark with slug ${slug}.`);
    return markdown(benchMarkdown(b), `/benchmarks/${slug}`);
  }
  if (head === "products" && slug && SLUG.test(slug)) {
    const p = await getProvider(slug);
    if (!p) return notFoundMd(`No product with slug ${slug}.`);
    return markdown(productMarkdown(p), `/products/${p.slug}`);
  }
  return notFoundMd("No Markdown view at this path.");
}
