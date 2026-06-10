/**
 * Embeddable SVG badge. One badge per (benchmark, provider).
 *
 * Endpoint shape:
 *   /api/badge/<benchmark-slug>/<provider-slug>?chain=<chain>&region=<region>
 *
 * Returns an SVG showing the provider's current rank + headline figure
 * on that bench. Cache-Control is short so the figure refreshes within
 * a few minutes of a new run.
 *
 * The optional `?chain=` / `?region=` query params scope the rank
 * computation. When the bench carries exact per-cell rankings (from its
 * `rank_matrix_query`), the rank comes from the matching cell, including
 * the combined scope `?chain=bnb&region=sgp`, and the scope labels are
 * printed as a subscript on the SVG so embedders don't broadcast a
 * chain- or region-restricted "#1" as a global finish (e.g. dRPC leading
 * only from Singapore reading as the worldwide chain leader).
 *
 * `?chain=` without cell data falls back to the legacy bestPerChain
 * approximation. `?region=` requires cell data (404 otherwise).
 *
 * When NO scope is provided, the badge falls back to the unfiltered
 * aggregate AND adds an "all chains" / "all regions" textual hint to the
 * SVG so the scope of the rank is visible at a glance.
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
// Text column starts right of the spinning logo sphere.
const TEXT_X = 48;
// The badge font is monospace, so line widths are predictable from the
// character count: SF Mono / Menlo advance is ~0.6em. Width is computed
// per request from the longest line so the full title always fits (no
// ellipsis), bounded to keep a malicious-length spec from emitting a
// billboard.
const CH_11 = 6.8; // 11px line (rank + title)
const CH_10 = 6.2; // 10px line (value + suffix)
const CH_8 = 5.4; // 8px scope subscript (incl. 0.6 letter-spacing)
const W_MIN = 300;
const W_MAX = 760;

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

/**
 * Exact scoped rank from the bench's per-cell rankings (populated by
 * `rank_matrix_query` in the spec). Cell keys are `<chain>|<region>` with
 * "all" standing in for an unscoped side (derived marginals included).
 * Returns null when the bench has no cell data, the cell is empty this
 * cycle, or the provider isn't ranked in it.
 */
function rankOfCell(
  b: Benchmark,
  providerSlug: string,
  chain: string | null,
  region: string | null,
): { rank: number; total: number; value: number } | null {
  const cell = b.cellRanks?.[`${chain ?? "all"}|${region ?? "all"}`];
  if (!cell || cell.length === 0) return null;
  const lower = providerSlug.toLowerCase();
  const idx = cell.findIndex((e) => e.slug.toLowerCase() === lower);
  if (idx === -1) return null;
  return { rank: idx + 1, total: cell.length, value: cell[idx].p50 };
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

/** Returns the human label for a region value from the bench's spec. */
function regionLabel(b: Benchmark, region: string): string {
  return b.dimensions?.region?.find((r) => r.value === region)?.label ?? region;
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

  // Scope params are normalized to lowercase and validated against the
  // bench's declared dimensions; an unknown value is treated as a 400
  // rather than silently falling back to "all", so an embedder who
  // mistypes can fix it instead of shipping a misleading unfiltered
  // figure under a scoped badge. The canonical dimension value (not the
  // raw param) feeds the cell lookup.
  const url = new URL(req.url);
  const rawChain = url.searchParams.get("chain")?.toLowerCase().trim() || null;
  const rawRegion = url.searchParams.get("region")?.toLowerCase().trim() || null;
  const chainParam = rawChain
    ? (b.dimensions?.chain?.find((c) => c.value.toLowerCase() === rawChain)
        ?.value ?? null)
    : null;
  const regionParam = rawRegion
    ? (b.dimensions?.region?.find((d) => d.value.toLowerCase() === rawRegion)
        ?.value ?? null)
    : null;
  if ((rawChain && !chainParam) || (rawRegion && !regionParam)) {
    return new NextResponse(rawChain && !chainParam ? "unknown chain" : "unknown region", {
      status: 400,
      headers: { "cache-control": "public, s-maxage=60" },
    });
  }

  let r: { rank: number; total: number; value: number } | null;
  let scopeLabel: string;
  if (chainParam || regionParam) {
    const cell = rankOfCell(b, provider, chainParam, regionParam);
    if (cell) {
      r = cell;
    } else if (chainParam && !regionParam) {
      // Legacy approximation for chain-dimensioned benches without a
      // rank_matrix_query in their spec.
      const scoped = rankOfChain(b, provider, chainParam);
      if (!scoped) {
        return new NextResponse("not found", { status: 404 });
      }
      r = { rank: scoped.rank, total: scoped.total, value: scoped.value };
    } else {
      return new NextResponse("not found", { status: 404 });
    }
    scopeLabel = [
      chainParam ? chainLabel(b, chainParam) : null,
      regionParam ? regionLabel(b, regionParam) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  } else {
    r = rankOf(b.results, provider, b.higherIsBetter);
    if (!r) return new NextResponse("not found", { status: 404 });
    // Hint the aggregate scope when the bench declares dimensions so
    // embedders can read it. Benches without dimensions get no scope
    // label (it would be noise).
    scopeLabel = [
      (b.dimensions?.chain?.filter((c) => c.value !== "all").length ?? 0) > 0
        ? "all chains"
        : null,
      (b.dimensions?.region?.filter((d) => d.value !== "all").length ?? 0) > 0
        ? "all regions"
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  // Colour signals rank. green for #1, dark ink for everyone else.
  const accent = r.rank === 1 ? "#3F7B47" : "#22272F";
  const rankLabel = `#${r.rank}/${r.total}`;
  const value = fmtUnit(r.value, b.unit);
  const suffix = valueSuffix(b.unit);
  // Full title by default; ellipsis only kicks in past the W_MAX bound
  // (schema allows 200-char titles, the canvas does not).
  const titleBudget = Math.floor(
    (W_MAX - TEXT_X - rankLabel.length * CH_11 - 7 - 8 - 30) / CH_11,
  );
  const title = truncate(b.title, titleBudget);

  // Size the canvas to the longest line. Line 1 ends before the OCB
  // wordmark in the top-right corner (~30px incl. margin); line 2 is the
  // figure plus the optional scope subscript.
  const line1W =
    TEXT_X +
    rankLabel.length * CH_11 +
    7 +
    title.length * CH_11 +
    8 +
    30;
  const line2W =
    TEXT_X +
    `${value} ${suffix}`.length * CH_10 +
    (scopeLabel ? 7 + scopeLabel.length * CH_8 : 0) +
    12;
  const W = Math.ceil(Math.min(Math.max(W_MIN, line1W, line2W), W_MAX));

  // Scope marker: small caps tspan appended to the figure line, so the
  // badge height stays constant whether or not a scope is present.
  const scopeAriaSuffix = scopeLabel ? ` (${scopeLabel})` : "";
  const scopeTspan = scopeLabel
    ? `<tspan dx="7" font-size="8" font-weight="600" fill="#9aa0a8" letter-spacing="0.6">${escapeXml(scopeLabel.toUpperCase())}</tspan>`
    : "";

  // The spinning mark: the masthead's 3D brand sphere (site-logo-3d.tsx)
  // faked in static SVG. Same texture geometry as the three.js canvas
  // (C-ring + grey corner markers packed in the sphere's front face),
  // dark skin, limb-darkening overlay and a specular highlight. The yaw
  // animation is a true 360: the mark slides toward the right limb with
  // cosine foreshortening, hides behind the sphere (plain dark back,
  // exactly like the real sphere), then re-enters from the left limb.
  // A background-colored cover ring hides the mark's overshoot past the
  // sphere's silhouette (clip-path on animated content is unreliable in
  // some <img> renderers; an opaque ring is not). CSS animations inside
  // SVG run in <img> embeds; the reduced-motion media query freezes the
  // mark front-and-center for users who opted out, which is also what
  // static renderers without CSS support show.
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="OpenChainBench: ${escapeXml(b.title)} ${rankLabel}${scopeAriaSuffix}, ${value}">
  <title>OpenChainBench. ${escapeXml(b.title)}. ${rankLabel}${scopeAriaSuffix}, ${value} ${suffix}</title>
  <style>
    @keyframes ocb-yaw{
      0%{transform:translateX(0) scaleX(1);opacity:1}
      12.5%{transform:translateX(9.2px) scaleX(0.707);opacity:1}
      24.9%{transform:translateX(13px) scaleX(0.04);opacity:1}
      25%{opacity:0}
      74.9%{transform:translateX(-13px) scaleX(0.04);opacity:0}
      75%{transform:translateX(-13px) scaleX(0.04);opacity:1}
      87.5%{transform:translateX(-9.2px) scaleX(0.707);opacity:1}
      100%{transform:translateX(0) scaleX(1);opacity:1}
    }
    .mark{animation:ocb-yaw 3.2s linear infinite;transform-origin:24px 22px}
    @media (prefers-reduced-motion:reduce){.mark{animation:none}}
  </style>
  <defs>
    <radialGradient id="sphere" cx="38%" cy="30%" r="85%">
      <stop offset="0%" stop-color="#2c323c"/>
      <stop offset="55%" stop-color="#171a20"/>
      <stop offset="100%" stop-color="#0a0c0f"/>
    </radialGradient>
    <radialGradient id="limb" cx="42%" cy="36%" r="70%">
      <stop offset="0%" stop-color="#0a0c0f" stop-opacity="0"/>
      <stop offset="66%" stop-color="#0a0c0f" stop-opacity="0"/>
      <stop offset="100%" stop-color="#0a0c0f" stop-opacity="0.8"/>
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
  <circle cx="24" cy="22" r="17" fill="none" stroke="#F5F1E8" stroke-width="6"/>
  <circle cx="24" cy="22" r="14" fill="url(#limb)"/>
  <ellipse cx="18" cy="15" rx="5" ry="3" fill="#fff" opacity="0.35" transform="rotate(-25 18 15)"/>
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
