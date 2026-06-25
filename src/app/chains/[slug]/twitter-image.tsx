import { ImageResponse } from "next/og";
import { CHAIN_BY_SLUG, getBenchmarksForChain } from "@/lib/chains";

export const runtime = "nodejs";
export const alt = "OpenChainBench. Open benchmarks for crypto infrastructure";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// On demand only. Same reasoning as benchmarks + products: prerendering
// every chain OG card at build wakes the Prom side and stretches the
// deploy beyond Vercel timeouts on cold caches.
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return [];
}

export default async function OG({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const chain = CHAIN_BY_SLUG.get(slug);
  if (!chain) return new ImageResponse(<div />, { ...size });

  const benches = await getBenchmarksForChain(slug);
  const count = benches.length;
  const benchLine = `${count} live benchmark${count === 1 ? "" : "s"} measured`;
  const categoryLine = chain.category === "L1" ? "Layer 1" : "Layer 2";
  const accent = "#6a9466";

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
          <span>OpenChainBench · Chain record</span>
          <span style={{ color: accent }}>{benchLine}</span>
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
            {categoryLine}
            {chain.nativeSymbol ? ` · ${chain.nativeSymbol}` : ""}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: chain.label.length > 18 ? 120 : 160,
              fontWeight: 700,
              lineHeight: 0.98,
              letterSpacing: -3,
              maxWidth: 1080,
            }}
          >
            {chain.label}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 26,
              fontStyle: "italic",
              color: "#4a443c",
              marginTop: 18,
              maxWidth: 1080,
            }}
          >
            {chain.description}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            fontSize: 22,
            color: "#7a7166",
          }}
        >
          <span>openchainbench.com/chains/{chain.slug}</span>
          <span style={{ fontSize: 16, letterSpacing: 3, textTransform: "uppercase" }}>
            Live data, open methodology
          </span>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}