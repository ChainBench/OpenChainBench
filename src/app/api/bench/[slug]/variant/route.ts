/**
 * On-demand bench variant for the client-side chain/region/kind tabs.
 *
 * GET /api/bench/<slug>/variant?chain=<c>&region=<r>&kind=<k>
 *
 * Returns the filtered Benchmark as JSON. Exists so the bench page can
 * ship ONLY the aggregate view (the old embedded variant map multiplied
 * every ISR regeneration by chains × regions × kinds full provider
 * loads). Each (slug, filters) combo is deduped across users by the
 * per-variant unstable_cache in the spec loader, so the first tab flip
 * per minute pays one Prom roundtrip and everyone else gets cache hits.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getBenchmark } from "@/data/benchmarks";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { SLUG_RE } from "@/lib/slug";

export const revalidate = 60;

type Params = { slug: string };

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<Params> },
) {
  const rl = rateLimit(clientKey(req, "variant"), 120, 60, req);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const { slug } = await params;
  if (!SLUG_RE.test(slug)) {
    return new NextResponse("bad_input", {
      status: 400,
      headers: { "cache-control": "public, s-maxage=60" },
    });
  }
  const aggregate = await getBenchmark(slug);
  if (!aggregate || aggregate.editorialStatus !== "live") {
    return new NextResponse("not found", {
      status: 404,
      headers: { "cache-control": "public, s-maxage=60" },
    });
  }

  // Validate every filter against the declared dimensions and use the
  // canonical value: these end up in PromQL label selectors downstream.
  const url = new URL(req.url);
  const filters: { chain?: string; region?: string; kind?: string } = {};
  for (const dim of ["chain", "region", "kind"] as const) {
    const raw = url.searchParams.get(dim)?.toLowerCase().trim();
    if (!raw || raw === "all") continue;
    const known = (aggregate.dimensions?.[dim] ?? []).find(
      (d) => d.value.toLowerCase() === raw,
    );
    if (!known) {
      return new NextResponse(`unknown ${dim}`, {
        status: 400,
        headers: { "cache-control": "public, s-maxage=60" },
      });
    }
    filters[dim] = known.value;
  }

  const variant =
    Object.keys(filters).length > 0
      ? ((await getBenchmark(slug, filters)) ?? aggregate)
      : aggregate;

  // Editorial copy resolves chain placeholders against the aggregate's
  // stashes (computed unfiltered only); without this override a chain
  // tab would surface raw `{{best_name:chain:X}}` strings.
  const payload =
    variant === aggregate
      ? variant
      : {
          ...variant,
          findings: aggregate.findings,
          faq: aggregate.faq,
          seoIntro: aggregate.seoIntro,
          abstract: aggregate.abstract,
          methodology: aggregate.methodology,
          perChainExplainer: aggregate.perChainExplainer,
          bestPerChain: aggregate.bestPerChain,
          worstPerChain: aggregate.worstPerChain,
        };

  return NextResponse.json(payload, {
    headers: {
      "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
      Vary: "Accept-Encoding",
    },
  });
}
