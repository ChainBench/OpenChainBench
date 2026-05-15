import { ImageResponse } from "next/og";
import { getBenchmark, getBenchmarkSlugs } from "@/data/benchmarks";
import { headlineSentence, leader } from "@/lib/citation";
import { fmtUnit } from "@/lib/format";
import { CATEGORY_COLOR } from "@/lib/category-colors";

export const runtime = "nodejs";
export const alt = "OpenChainBench. Open benchmarks for crypto infrastructure";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export async function generateStaticParams() {
  const slugs = await getBenchmarkSlugs();
  return slugs.map((slug) => ({ slug }));
}

export default async function TwitterImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const b = await getBenchmark(slug);
  if (!b) return new ImageResponse(<div />, { ...size });

  const top = leader(b);
  const headline = top ? `${top.name} leads at ${fmtUnit(top.value, b.unit)}` : "Awaiting first run";
  const sentence = headlineSentence(b);
  const catColor = CATEGORY_COLOR[b.category] ?? "#7a2e1f";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#f8f3eb",
          color: "#1c1a17",
          padding: 60,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          fontFamily: "Georgia, serif",
          backgroundImage:
            "radial-gradient(rgba(28,26,23,0.06) 1px, transparent 1px)",
          backgroundSize: "6px 6px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 18,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: "#7a7166",
          }}
        >
          <span>OpenChainBench · Bench № {b.number}</span>
          <span style={{ color: catColor }}>{b.category}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 22,
              letterSpacing: 6,
              textTransform: "uppercase",
              color: catColor,
              marginBottom: 14,
            }}
          >
            {b.metric}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: b.title.length > 38 ? 76 : 92,
              fontWeight: 700,
              lineHeight: 0.98,
              letterSpacing: -2,
              maxWidth: 1080,
            }}
          >
            {b.title}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 28,
              fontStyle: "italic",
              color: "#4a443c",
              marginTop: 18,
              maxWidth: 1080,
            }}
          >
            {top ? sentence : b.subtitle}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: "2px solid #1c1a17",
            paddingTop: 20,
            fontSize: 18,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: "#1c1a17",
          }}
        >
          <span>openchainbench.com/benchmarks/{b.slug}</span>
          <span style={{ fontFamily: "Georgia, serif", letterSpacing: 2 }}>
            {headline}
          </span>
        </div>
      </div>
    ),
    { ...size }
  );
}
