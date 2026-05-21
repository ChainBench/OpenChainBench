import { ImageResponse } from "next/og";
import { getProvider, getProviderSlugs } from "@/lib/providers";

export const runtime = "nodejs";
export const alt = "OpenChainBench. Open benchmarks for crypto infrastructure";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export async function generateStaticParams() {
  const slugs = await getProviderSlugs();
  return slugs.map((slug) => ({ slug }));
}

export default async function OG({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const p = await getProvider(slug);
  if (!p) return new ImageResponse(<div />, { ...size });

  const top1Line =
    p.wins > 0
      ? `#1 on ${p.wins} benchmark${p.wins === 1 ? "" : "s"}`
      : "Tracked across the leaderboard";
  const appearancesLine = `${p.appearances.length} benchmark${p.appearances.length === 1 ? "" : "s"} measured`;
  const accent = p.wins > 0 ? "#6a9466" : "#7a7166";

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
          <span>OpenChainBench · Product record</span>
          <span style={{ color: accent }}>{top1Line}</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 22,
              letterSpacing: 6,
              textTransform: "uppercase",
              color: accent,
              marginBottom: 14,
            }}
          >
            {p.categories.join(" · ") || "Tracked"}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: p.name.length > 24 ? 110 : 140,
              fontWeight: 700,
              lineHeight: 0.98,
              letterSpacing: -3,
              maxWidth: 1080,
            }}
          >
            {p.name}
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
            {appearancesLine} on OpenChainBench
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
          <span>openchainbench.com/products/{p.slug}</span>
          <span style={{ fontFamily: "Georgia, serif", letterSpacing: 2 }}>
            Live record
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
