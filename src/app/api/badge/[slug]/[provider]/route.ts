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

const H = 44;
// Width is fixed but generous so most benchmark titles fit without
// truncation. Anything over ~32 chars gets ellipsis.
const W = 360;
// Text column starts right of the spinning logo sphere.
const TEXT_X = 48;
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

  // Scope marker: small caps tspan appended to the figure line, so the
  // badge height stays constant whether or not a scope is present.
  const scopeAriaSuffix = scopeLabel ? ` (${scopeLabel})` : "";
  const scopeTspan = scopeLabel
    ? `<tspan dx="7" font-size="8" font-weight="600" fill="#9aa0a8" letter-spacing="0.6">${escapeXml(scopeLabel.toUpperCase())}</tspan>`
    : "";

  // The spinning mark: the dark-mode brand sphere (near-black skin,
  // light C-ring + grey corner markers, same geometry as site-logo.tsx)
  // doing a continuous 360 around its vertical axis. The spin is a CSS
  // coin-flip (scaleX 1 -> 0 -> 1); while scaleX is 0 the plain dark
  // sphere shows, which is exactly what the back of the masthead sphere
  // looks like. CSS animations inside SVG run in <img> embeds, and the
  // reduced-motion media query freezes it for users who opted out.
  // Static renderers without CSS support just show the un-rotated mark.
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="OpenChainBench: ${escapeXml(b.title)} ${rankLabel}${scopeAriaSuffix}, ${value}">
  <title>OpenChainBench. ${escapeXml(b.title)}. ${rankLabel}${scopeAriaSuffix}, ${value} ${suffix}</title>
  <style>
    @keyframes ocb-spin{0%{transform:scaleX(1);animation-timing-function:ease-in}35%{transform:scaleX(0)}65%{transform:scaleX(0);animation-timing-function:ease-out}100%{transform:scaleX(1)}}
    .mark{animation:ocb-spin 2.6s infinite;transform-origin:24px 22px}
    @media (prefers-reduced-motion:reduce){.mark{animation:none}}
  </style>
  <defs>
    <radialGradient id="sphere" cx="35%" cy="30%" r="80%">
      <stop offset="0%" stop-color="#2a2f38"/>
      <stop offset="100%" stop-color="#0e1014"/>
    </radialGradient>
    <mask id="cmark">
      <rect width="100" height="100" fill="#fff"/>
      <ellipse cx="45" cy="50" rx="22" ry="40" fill="#000"/>
      <rect x="45" y="38" width="55" height="24" fill="#000"/>
    </mask>
  </defs>
  <rect width="${W}" height="${H}" rx="6" fill="#F5F1E8"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="5.5" fill="none" stroke="#22272F" stroke-opacity="0.12"/>
  <circle cx="24" cy="22" r="14" fill="url(#sphere)"/>
  <g class="mark">
    <g transform="translate(14.2 12.2) scale(0.196)">
      <circle cx="45" cy="50" r="45" fill="#f8fafc" mask="url(#cmark)"/>
      <path d="M65 0 L100 0 L100 35 Z" fill="#A0A0A0"/>
      <path d="M65 100 L100 100 L100 65 Z" fill="#A0A0A0"/>
    </g>
  </g>
  <ellipse cx="19" cy="16" rx="6" ry="3.5" fill="#fff" opacity="0.14" transform="rotate(-25 19 16)"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace">
    <text x="${TEXT_X}" y="18" font-size="11"><tspan fill="${accent}" font-weight="700">${rankLabel}</tspan><tspan dx="7" fill="#22272F" font-weight="600">${escapeXml(title)}</tspan></text>
    <text x="${TEXT_X}" y="33" fill="#5A6068" font-size="10" font-weight="500">${value} <tspan fill="#9aa0a8">${suffix}</tspan>${scopeTspan}</text>
    <text x="${W - 10}" y="14" text-anchor="end" fill="#9aa0a8" font-size="7.5" font-weight="600" letter-spacing="1.4">OCB</text>
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
