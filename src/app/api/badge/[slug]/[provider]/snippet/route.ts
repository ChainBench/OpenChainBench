/**
 * Copy-paste embed snippets for the per-(benchmark, provider) badge SVG.
 *
 *   GET /api/badge/<bench>/<provider>/snippet?format=markdown|html|url|json
 *
 * Returns a ready-to-paste embed code so a provider can drop a live
 * "Ranked #N on OpenChainBench" badge into their README, docs page,
 * or marketing site without crafting the URL by hand. The badge SVG
 * itself still lives at /api/badge/<bench>/<provider>; this endpoint
 * only wraps it.
 *
 * Why this exists separately from the SVG route: it is the one
 * surface readers reach for when they want to BACKLINK us. Keeping
 * snippet rendering out of the SVG path keeps the SVG cache hot
 * (one cacheable shape per benchmark + provider) and avoids polluting
 * the SVG content negotiation with a text/* branch.
 *
 * Optional query params forwarded to the badge URL so a provider can
 * embed a scope-restricted badge (chain, region, kind). The site URL
 * the badge links to also picks up the same scope where applicable,
 * so a reader clicking through lands on the matching variant view.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getBenchmark } from "@/data/benchmarks";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { PROVIDER_RE, SLUG_RE } from "@/lib/slug";
import { SITE } from "@/data/site";

export const revalidate = 600;

type Params = { slug: string; provider: string };

const FORMATS = ["markdown", "html", "url", "json"] as const;
type Format = (typeof FORMATS)[number];

function isFormat(v: string | null): v is Format {
  return v != null && (FORMATS as readonly string[]).includes(v);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<Params> },
) {
  const r = rateLimit(clientKey(req, "badge-snippet"), 120, 60);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  const { slug, provider } = await params;
  if (!SLUG_RE.test(slug) || !PROVIDER_RE.test(provider)) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }

  const benchmark = await getBenchmark(slug);
  if (!benchmark) {
    return NextResponse.json({ error: "bench_not_found" }, { status: 404 });
  }
  const result = benchmark.results.find((p) => p.slug === provider);
  if (!result) {
    return NextResponse.json({ error: "provider_not_found" }, { status: 404 });
  }

  const sp = req.nextUrl.searchParams;
  const format: Format = isFormat(sp.get("format")) ? (sp.get("format") as Format) : "markdown";
  const chain = sp.get("chain")?.trim() || "";
  const region = sp.get("region")?.trim() || "";
  const kind = sp.get("kind")?.trim() || "";

  const scopeQs = new URLSearchParams();
  if (chain) scopeQs.set("chain", chain);
  if (region) scopeQs.set("region", region);
  if (kind) scopeQs.set("kind", kind);
  const scopeSuffix = scopeQs.toString();

  const badgeUrl =
    `${SITE.url}/api/badge/${slug}/${provider}` +
    (scopeSuffix ? `?${scopeSuffix}` : "");
  const benchUrl =
    `${SITE.url}/benchmarks/${slug}` +
    (scopeSuffix ? `?${scopeSuffix}` : "");

  const alt = `OpenChainBench ${benchmark.title} ranking for ${result.name}`;

  const snippets = {
    markdown: `[![${alt}](${badgeUrl})](${benchUrl})`,
    html: `<a href="${benchUrl}" target="_blank" rel="noopener"><img src="${badgeUrl}" alt="${alt}" /></a>`,
    url: badgeUrl,
  } as const;

  if (format === "json") {
    return NextResponse.json(
      {
        benchmark: { slug, title: benchmark.title, url: benchUrl },
        provider: { slug: provider, name: result.name },
        badge_url: badgeUrl,
        snippets,
        scope: { chain: chain || null, region: region || null, kind: kind || null },
        license: "CC-BY-4.0",
      },
      {
        headers: {
          "cache-control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      },
    );
  }

  return new NextResponse(snippets[format], {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
