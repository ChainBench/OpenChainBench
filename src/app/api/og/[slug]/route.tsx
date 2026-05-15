import { ImageResponse } from "next/og";
import { getBenchmark } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import { fmtUnit } from "@/lib/format";
import { fieldValue, leader, sparklineFor } from "@/lib/citation";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { SLUG_RE } from "@/lib/slug";

export const runtime = "nodejs";
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };


/**
 * 1200×630 PNG OG image with the current value, leader and a sparkline,
 * watermarked with the site URL. Every Twitter / Slack / Discord unfurl
 * of a `/benchmarks/<slug>` link surfaces this image. The watermark
 * makes every screenshot a backlink.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const r = rateLimit(clientKey(req, "og"), 60, 60);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  const { slug } = await params;
  if (!SLUG_RE.test(slug)) {
    return new Response("bad_slug", {
      status: 400,
      headers: { "cache-control": "public, s-maxage=60" },
    });
  }
  const b = await getBenchmark(slug);
  if (!b || b.editorialStatus !== "live") {
    return new Response("not_found", {
      status: 404,
      headers: { "cache-control": "public, s-maxage=60" },
    });
  }

  const top = leader(b);
  const value = fieldValue(b);
  const valueStr = value != null ? fmtUnit(value, b.unit) : "-";
  const spark = sparklineFor(b, top?.slug);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#f8f3eb",
          color: "#181614",
          padding: 64,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          fontFamily: "Georgia, serif",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 28,
                height: 28,
                background: "#181614",
                borderRadius: 4,
              }}
            />
            <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: -0.5 }}>
              OpenChainBench
            </span>
          </div>
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 14,
              color: "#7a7166",
              textTransform: "uppercase",
              letterSpacing: 2,
            }}
          >
            {b.category} · No. {b.number}
          </span>
        </div>

        {/* Body */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 16,
              color: "#7a7166",
              textTransform: "uppercase",
              letterSpacing: 2,
            }}
          >
            {b.metric}
          </span>
          <span style={{ fontSize: 124, fontWeight: 700, lineHeight: 0.95, letterSpacing: -3 }}>
            {valueStr}
          </span>
          <span style={{ fontSize: 28, color: "#4a443c", maxWidth: 980 }}>
            {top ? `${top.name} leads · ${b.title}` : b.title}
          </span>
        </div>

        {/* Sparkline */}
        {spark.length > 1 && <Sparkline values={spark} width={1072} height={88} />}

        {/* Footer / watermark */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            fontFamily: "monospace",
            fontSize: 18,
            color: "#7a7166",
            borderTop: "1px solid #ddd2b9",
            paddingTop: 18,
          }}
        >
          <span>{SITE.url.replace("https://", "")}/benchmarks/{b.slug}</span>
          <span>CC-BY-4.0</span>
        </div>
      </div>
    ),
    size,
  );
}

function Sparkline({
  values,
  width,
  height,
}: {
  values: number[];
  width: number;
  height: number;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const pts = values
    .map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline
        fill="none"
        stroke="#181614"
        strokeWidth={2.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        points={pts}
      />
    </svg>
  );
}
