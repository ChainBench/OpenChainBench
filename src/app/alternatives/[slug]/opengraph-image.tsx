import { ImageResponse } from "next/og";
import { loadAlternative } from "@/lib/alternatives";

export const runtime = "nodejs";
export const alt = "OpenChainBench. Open benchmarks for crypto infrastructure";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Rendered ON DEMAND, same reasoning as /products/[slug]/opengraph-image:
// prerendering these at build multiplies the full Prom load per build worker.
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return [];
}

export default async function OG({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const a = await loadAlternative(slug);
  if (!a) return new ImageResponse(<div />, { ...size });

  const title = `${a.target_product} alternatives`;
  const intro =
    a.intro.length > 140 ? `${a.intro.slice(0, 137).trimEnd()}…` : a.intro;

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
          <span>OpenChainBench · Alternatives</span>
          <span style={{ color: "#6a9466" }}>Live benchmark data</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: title.length > 24 ? 90 : 120,
              fontWeight: 700,
              lineHeight: 0.98,
              letterSpacing: -3,
              maxWidth: 1080,
            }}
          >
            {title}
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
            {intro}
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
          <span>openchainbench.com/alternatives/{a.slug}</span>
          <span style={{ fontFamily: "Georgia, serif", letterSpacing: 2 }}>
            Measured, not sponsored
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
