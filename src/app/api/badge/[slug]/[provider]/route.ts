/**
 * Embeddable SVG badge. One badge per (benchmark, provider).
 *
 * Endpoint shape: /api/badge/<benchmark-slug>/<provider-slug>
 *
 * Returns an SVG showing the provider's current rank + p50 on that bench.
 * Cache-Control is short so the figure refreshes within a few minutes of
 * a new run, but long enough to absorb burst traffic without hammering
 * Prometheus on every page load.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getBenchmark } from "@/data/benchmarks";
import { fmtUnit } from "@/lib/format";

export const revalidate = 300;

type Params = { slug: string; provider: string };

const W = 240;
const H = 28;

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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<Params> },
) {
  const { slug, provider } = await params;
  const b = await getBenchmark(slug);
  if (!b || b.status !== "live") {
    return new NextResponse("not found", { status: 404 });
  }
  const r = rankOf(b.results, provider, b.higherIsBetter);
  if (!r) return new NextResponse("not found", { status: 404 });

  const accent = r.rank === 1 ? "#3F7B47" : "#22272F";
  const rankLabel = `#${r.rank} of ${r.total}`;
  const valueLabel = `${fmtUnit(r.value, b.unit)} p50`;
  const benchLabel = b.title.length > 30 ? `${b.title.slice(0, 28)}...` : b.title;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="OpenChainBench: ${benchLabel} ${rankLabel}">
  <title>OpenChainBench. ${benchLabel}. ${rankLabel}, ${valueLabel}</title>
  <rect width="${W}" height="${H}" rx="3" fill="#F5F1E8"/>
  <rect x="0" y="0" width="68" height="${H}" rx="3" fill="${accent}"/>
  <rect x="65" y="0" width="3" height="${H}" fill="${accent}"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="10">
    <text x="6" y="11" fill="#F5F1E8" font-weight="600" letter-spacing="1.2">OCB</text>
    <text x="6" y="22" fill="#F5F1E8" font-weight="500">${rankLabel}</text>
    <text x="76" y="11" fill="#22272F" font-weight="600">${escapeXml(benchLabel)}</text>
    <text x="76" y="22" fill="#5A6068">${valueLabel}</text>
  </g>
</svg>`;

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
    },
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
