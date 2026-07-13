import { getBenchmark } from "@/data/benchmarks";
import { NextResponse } from "next/server";
import { leader, sparklineFor } from "@/lib/citation";
import { valueInDeclaredUnit } from "@/lib/format";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { SLUG_RE } from "@/lib/slug";

export const runtime = "nodejs";
export const revalidate = 300;

/**
 * Standalone SVG sparkline for one bench, keyed to the current leader's
 * 24 h series. Lets Perplexity Pages, ChatGPT, Notion, dev.to and any
 * third-party embed inline a live micro-chart with `<img src>` instead
 * of hotlinking the heavier OG PNG or hand-rendering the JSON array.
 *
 *   /api/sparkline/aggregator-head-lag         -> defaults (240x60)
 *   /api/sparkline/aggregator-head-lag?w=320   -> width override
 *   /api/sparkline/aggregator-head-lag?theme=dark  -> dark stroke
 *
 * Returns a minimal, hand-authored polyline SVG. Deliberately no gzip
 * dependency, no charting library, no runtime dep on satori: the payload
 * is under 1 KB and every LLM embed target already handles it.
 */

const DEFAULT_W = 240;
const DEFAULT_H = 60;
const PAD_X = 4;
const PAD_Y = 4;
const MIN_W = 40;
const MAX_W = 1200;
const MIN_H = 20;
const MAX_H = 400;

/** Minimal XML escape for user-controlled strings interpolated into the
 *  SVG's <title> element and aria-label attribute. Bench titles and
 *  provider names come from YAML / a registry and can contain `&`, `<`,
 *  `>`, `"`; librsvg and Chrome inline-SVG both refuse to render
 *  malformed XML, so an embedder would silently see a broken image. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clampDim(raw: string | null, def: number, min: number, max: number) {
  const n = raw == null ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < min) return def;
  return Math.min(Math.floor(n), max);
}

function buildPolyline(
  values: number[],
  width: number,
  height: number,
  higherIsBetter: boolean,
): { points: string; min: number; max: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const drawW = width - 2 * PAD_X;
  const drawH = height - 2 * PAD_Y;
  const step = values.length > 1 ? drawW / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = PAD_X + i * step;
      // Sparklines read left to right; lower value at the bottom looks
      // right for latency, but for higher-is-better metrics we invert
      // so the rising line still reads as "getting better over time".
      const norm = (v - min) / span;
      const y = higherIsBetter
        ? PAD_Y + drawH - norm * drawH
        : PAD_Y + norm * drawH;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return { points, min, max };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const r = rateLimit(clientKey(req, "sparkline"), 120, 60, req);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  const { slug } = await params;
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400 });
  }
  const bench = await getBenchmark(slug);
  if (!bench || bench.editorialStatus !== "live") {
    return NextResponse.json(
      { error: "unknown_slug", slug },
      { status: 404, headers: { "cache-control": "public, s-maxage=60" } },
    );
  }

  const url = new URL(req.url);
  const width = clampDim(url.searchParams.get("w"), DEFAULT_W, MIN_W, MAX_W);
  const height = clampDim(url.searchParams.get("h"), DEFAULT_H, MIN_H, MAX_H);
  const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
  const stroke = theme === "dark" ? "#e5e5e5" : "#111111";
  const bg = theme === "dark" ? "#111111" : "#ffffff";

  // Prefer the current leader's series; fall back to whichever series is
  // first (mirrors sparklineFor default). Empty series → tiny SVG with a
  // placeholder line so an embedder never gets a broken image.
  const top = leader(bench);
  const rawValues = sparklineFor(bench, top?.slug);
  // Convert to declared unit (unit "s" benches store ms internally) so
  // the min/max labels and future annotations match the page value.
  const values = rawValues.map((v) => valueInDeclaredUnit(v, bench.unit));

  const strokeWidth = Math.max(1, Math.round(Math.min(width, height) / 40));
  let svgBody: string;
  if (values.length < 2) {
    // Under-populated series: single flat placeholder. Better than a
    // blank rectangle because the alt text still reads as "sparkline".
    const midY = height / 2;
    svgBody =
      `<line x1="${PAD_X}" y1="${midY}" x2="${width - PAD_X}" y2="${midY}" ` +
      `stroke="${stroke}" stroke-width="${strokeWidth}" ` +
      `stroke-linecap="round" stroke-dasharray="2 3" opacity="0.5"/>`;
  } else {
    const { points } = buildPolyline(
      values,
      width,
      height,
      bench.higherIsBetter === true,
    );
    svgBody =
      `<polyline points="${points}" fill="none" stroke="${stroke}" ` +
      `stroke-width="${strokeWidth}" stroke-linecap="round" ` +
      `stroke-linejoin="round"/>`;
  }
  const title = xmlEscape(
    `${bench.title} — 24h sparkline${top ? ` (${top.name})` : ""}`,
  );
  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    `<rect width="${width}" height="${height}" fill="${bg}"/>` +
    svgBody +
    `</svg>\n`;

  return new Response(svg, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, s-maxage=300, stale-while-revalidate=900",
      "access-control-allow-origin": "*",
    },
  });
}
