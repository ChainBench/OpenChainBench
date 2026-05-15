/**
 * Embeddable SVG badge. One badge per (benchmark, provider).
 *
 * Endpoint shape: /api/badge/<benchmark-slug>/<provider-slug>
 *
 * Returns an SVG showing the provider's current rank + headline figure
 * on that bench. Cache-Control is short so the figure refreshes within
 * a few minutes of a new run.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getBenchmark } from "@/data/benchmarks";
import { fmtUnit } from "@/lib/format";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { PROVIDER_RE, SLUG_RE } from "@/lib/slug";

export const revalidate = 300;

type Params = { slug: string; provider: string };

const H = 36;
// Width is fixed but generous so most benchmark titles fit without
// truncation. Anything over ~32 chars gets ellipsis.
const W = 360;
const LEFT_W = 78;
const TITLE_MAX = 32;

function rankOf(
  results: { slug: string; ms: { p50: number } }[],
  providerSlug: string,
  higherIsBetter: boolean,
): { rank: number; total: number; value: number } | null {
  const live = results.filter((r) => r.ms.p50 > 0);
  if (live.length === 0) return null;
  const sorted = [...live].sort((a, b) =>
    higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
  );
  const idx = sorted.findIndex(
    (r) => r.slug.toLowerCase() === providerSlug.toLowerCase(),
  );
  if (idx === -1) return null;
  return { rank: idx + 1, total: sorted.length, value: sorted[idx].ms.p50 };
}

function valueSuffix(unit: string): string {
  if (unit === "count") return "(24h)";
  if (unit === "pct" || unit === "bps") return "(24h avg)";
  return "(p50, 24h)";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<Params> },
) {
  const rl = rateLimit(clientKey(req, "badge"), 120, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const { slug, provider } = await params;
  if (!SLUG_RE.test(slug) || !PROVIDER_RE.test(provider)) {
    return new NextResponse("bad_input", {
      status: 400,
      headers: { "cache-control": "public, s-maxage=60" },
    });
  }
  const b = await getBenchmark(slug);
  if (!b || b.editorialStatus !== "live") {
    return new NextResponse("not found", {
      status: 404,
      headers: { "cache-control": "public, s-maxage=60" },
    });
  }
  const r = rankOf(b.results, provider, b.higherIsBetter);
  if (!r) return new NextResponse("not found", { status: 404 });

  // Colour signals rank. green for #1, dark ink for everyone else.
  const accent = r.rank === 1 ? "#3F7B47" : "#22272F";
  const rankLabel = `#${r.rank}/${r.total}`;
  const value = fmtUnit(r.value, b.unit);
  const suffix = valueSuffix(b.unit);
  const title = truncate(b.title, TITLE_MAX);

  // Provider initials in the bottom-left corner. mirrors the brand
  // chip the site uses internally.
  const ocbBrand = "OCB";

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="OpenChainBench: ${escapeXml(b.title)} ${rankLabel}, ${value}">
  <title>OpenChainBench. ${escapeXml(b.title)}. ${rankLabel}, ${value} ${suffix}</title>
  <rect width="${W}" height="${H}" rx="4" fill="#F5F1E8"/>
  <rect width="${LEFT_W}" height="${H}" rx="4" fill="${accent}"/>
  <rect x="${LEFT_W - 4}" width="4" height="${H}" fill="${accent}"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace">
    <text x="10" y="15" fill="#F5F1E8" font-size="9" font-weight="600" letter-spacing="1.6">${ocbBrand}</text>
    <text x="10" y="28" fill="#F5F1E8" font-size="12" font-weight="700" letter-spacing="0.4">${rankLabel}</text>
    <text x="${LEFT_W + 12}" y="15" fill="#22272F" font-size="11" font-weight="600">${escapeXml(title)}</text>
    <text x="${LEFT_W + 12}" y="28" fill="#5A6068" font-size="10" font-weight="500">${value} <tspan fill="#9aa0a8">${suffix}</tspan></text>
  </g>
</svg>`;

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
    },
  });
}

// C0 control chars (minus \t \n \r) + DEL are forbidden in XML 1.0 text.
// A spec PR with a title containing one of these would otherwise produce
// an SVG that browsers refuse to render — self-DoS on every embed of the
// badge. Strip before escaping the XML metachars.
const XML_FORBIDDEN_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]",
  "g",
);

function escapeXml(s: string): string {
  return s
    .replace(XML_FORBIDDEN_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
