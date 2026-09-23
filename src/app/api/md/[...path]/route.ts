import { NextResponse, type NextRequest } from "next/server";
import { getBenchmark } from "@/data/benchmarks";
import { getProvider } from "@/lib/providers";
import { fetchPerpCohort } from "@/lib/perp-stats";
import { benchMarkdown, perpsHubMarkdown, productMarkdown } from "@/lib/markdown-views";

/**
 * Markdown views of a bench, the perps hub and a product page, at
 * /api/md/<the page's own path>. The header-conditioned rewrites in
 * next.config.ts (`rewrites()`, beforeFiles) send the HTML URL here when
 * the client's Accept header prefers text/markdown, so
 * `curl -H 'Accept: text/markdown' https://openchainbench.com/perps`
 * answers with the table an agent can read without a DOM.
 */
export const revalidate = 300;

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
      "cache-control": "public, s-maxage=300, stale-while-revalidate=600",
      link: `<${canonical}>; rel="canonical"`,
      vary: "Accept",
    },
  });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const [head, slug, extra] = path ?? [];
  if (extra !== undefined) return notFoundMd("No Markdown view at this path.");

  if (head === "perps" && slug === undefined) {
    const cohort = await fetchPerpCohort();
    return markdown(perpsHubMarkdown(cohort), "/perps");
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
