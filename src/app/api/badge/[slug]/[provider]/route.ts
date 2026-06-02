/**
 * Embeddable SVG badge. One badge per (benchmark, provider).
 *
 * Endpoint shape: /api/badge/<benchmark-slug>/<provider-slug>?chain=<chain>
 *
 * Returns an SVG showing the provider's current rank + headline figure
 * on that bench. Cache-Control is short so the figure refreshes within
 * a few minutes of a new run.
 *
 * The optional `?chain=` query param scopes the rank computation to a
 * single chain (e.g. `?chain=solana`). When present, the badge:
 *   - computes rank within the providers that have a measurement on
 *     that chain (read from `benchmark.bestPerChain`).
 *   - prints the chain label as a subscript on the SVG so embedders
 *     don't mistakenly broadcast a chain-restricted "#1" as a global
 *     finish (e.g. a Solana-only provider being aggregate #1 mechanically
 *     on a cross-chain bench).
 *
 * When NO `chain` is provided, the badge falls back to the unfiltered
 * aggregate AND adds an "all chains" textual hint to the SVG so the
 * scope of the rank is visible at a glance.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getBenchmark } from "@/data/benchmarks";
import { fmtUnit } from "@/lib/format";
import { readBestPerChain } from "@/lib/per-chain-contract";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { PROVIDER_RE, SLUG_RE } from "@/lib/slug";
import type { Benchmark, ProviderResult } from "@/types/benchmark";

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

/**
 * Per-chain rank computation. Uses `bestPerChain` (the precomputed leader
 * per chain stash from spec.ts) to scope the rank to providers active on
 * the requested chain. The leader is forced to rank #1; everyone else is
 * ranked by their unfiltered p50 within the providers whose bestPerChain
 * entry exists on at least one chain (soft approximation — full per-chain
 * leaderboards live on the bench page chain tabs).
 *
 * Returns null when:
 *  - the bench has no `bestPerChain` (no chain dimensions on this bench).
 *  - the chain is unknown or has no leader this cycle.
 *  - the provider isn't present in the unfiltered results.
 */
function rankOfChain(
  b: Benchmark,
  providerSlug: string,
  chain: string,
): { rank: number; total: number; value: number; leader: ProviderResult } | null {
  const bestPerChain = readBestPerChain(b);
  if (!bestPerChain) return null;
  const leader = bestPerChain[chain];
  if (!leader) return null;
  const live = b.results.filter((r) => r.ms.p50 > 0);
  if (live.length === 0) return null;
  const lower = providerSlug.toLowerCase();
  const others = live.filter(
    (r) => r.slug.toLowerCase() !== leader.slug.toLowerCase(),
  );
  const sortedOthers = [...others].sort((a, c) =>
    b.higherIsBetter ? c.ms.p50 - a.ms.p50 : a.ms.p50 - c.ms.p50,
  );
  const total = live.length;
  if (leader.slug.toLowerCase() === lower) {
    return { rank: 1, total, value: leader.ms.p50, leader };
  }
  const idx = sortedOthers.findIndex((r) => r.slug.toLowerCase() === lower);
  if (idx === -1) return null;
  return {
    rank: idx + 2, // +1 for 1-index, +1 because leader took slot 1
    total,
    value: sortedOthers[idx].ms.p50,
    leader,
  };
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

/** Returns the human label for a chain value from the bench's spec. */
function chainLabel(b: Benchmark, chain: string): string {
  return b.dimensions?.chain?.find((c) => c.value === chain)?.label ?? chain;
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

  // Chain scoping. Query param is normalized to lowercase and validated
  // against the bench's declared chain dimensions; an unknown chain is
  // treated as a 400 rather than silently falling back to "all", so an
  // embedder who mistypes can fix it instead of shipping a misleading
  // unfiltered figure under a chain badge.
  const url = new URL(req.url);
  const chainParam = url.searchParams.get("chain")?.toLowerCase().trim() || null;
  if (chainParam) {
    const known = b.dimensions?.chain?.some(
      (c) => c.value.toLowerCase() === chainParam,
    );
    if (!known) {
      return new NextResponse("unknown chain", {
        status: 400,
        headers: { "cache-control": "public, s-maxage=60" },
      });
    }
  }

  let r: { rank: number; total: number; value: number } | null;
  let scopeLabel: string;
  if (chainParam) {
    const scoped = rankOfChain(b, provider, chainParam);
    if (!scoped) {
      return new NextResponse("not found", { status: 404 });
    }
    r = { rank: scoped.rank, total: scoped.total, value: scoped.value };
    scopeLabel = chainLabel(b, chainParam);
  } else {
    r = rankOf(b.results, provider, b.higherIsBetter);
    if (!r) return new NextResponse("not found", { status: 404 });
    // Add an "all chains" hint when the bench declares chain dimensions so
    // embedders can read the scope. Benches without chain dimensions get
    // no scope label (it would be noise).
    scopeLabel =
      (b.dimensions?.chain?.filter((c) => c.value !== "all").length ?? 0) > 0
        ? "all chains"
        : "";
  }

  // Colour signals rank. green for #1, dark ink for everyone else.
  const accent = r.rank === 1 ? "#3F7B47" : "#22272F";
  const rankLabel = `#${r.rank}/${r.total}`;
  const value = fmtUnit(r.value, b.unit);
  const suffix = valueSuffix(b.unit);
  const title = truncate(b.title, TITLE_MAX);

  // Provider initials in the bottom-left corner. mirrors the brand
  // chip the site uses internally.
  const ocbBrand = "OCB";

  // Scope marker: rendered as a small subscript next to the rank when
  // present. Keeps the badge layout stable when absent (most benches).
  const scopeAriaSuffix = scopeLabel ? ` (${scopeLabel})` : "";
  const scopeSvg = scopeLabel
    ? `<text x="${LEFT_W + 12}" y="38" fill="#9aa0a8" font-size="8" font-weight="600" letter-spacing="0.6">${escapeXml(scopeLabel.toUpperCase())}</text>`
    : "";
  // Bump the SVG canvas height when a scope label is rendered so the
  // subscript doesn't clip outside the box on stricter image renderers.
  const svgH = scopeLabel ? H + 8 : H;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${svgH}" viewBox="0 0 ${W} ${svgH}" role="img" aria-label="OpenChainBench: ${escapeXml(b.title)} ${rankLabel}${scopeAriaSuffix}, ${value}">
  <title>OpenChainBench. ${escapeXml(b.title)}. ${rankLabel}${scopeAriaSuffix}, ${value} ${suffix}</title>
  <rect width="${W}" height="${svgH}" rx="4" fill="#F5F1E8"/>
  <rect width="${LEFT_W}" height="${svgH}" rx="4" fill="${accent}"/>
  <rect x="${LEFT_W - 4}" width="4" height="${svgH}" fill="${accent}"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace">
    <text x="10" y="15" fill="#F5F1E8" font-size="9" font-weight="600" letter-spacing="1.6">${ocbBrand}</text>
    <text x="10" y="28" fill="#F5F1E8" font-size="12" font-weight="700" letter-spacing="0.4">${rankLabel}</text>
    <text x="${LEFT_W + 12}" y="15" fill="#22272F" font-size="11" font-weight="600">${escapeXml(title)}</text>
    <text x="${LEFT_W + 12}" y="28" fill="#5A6068" font-size="10" font-weight="500">${value} <tspan fill="#9aa0a8">${suffix}</tspan></text>
    ${scopeSvg}
  </g>
</svg>`;

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      // Cache key varies by query string (chain), so different scopes get
      // their own CDN entries instead of cross-poisoning each other.
      Vary: "Accept, Accept-Encoding",
      "Cache-Control":
        "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
    },
  });
}

// C0 control chars (minus \t \n \r) + DEL are forbidden in XML 1.0 text.
// A spec PR with a title containing one of these would otherwise produce
// an SVG that browsers refuse to render - self-DoS on every embed of the
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
