import { ImageResponse } from "next/og";
import { getBenchmark } from "@/data/benchmarks";
import { headlineSentence, leader } from "@/lib/citation";
import { fmtUnit } from "@/lib/format";
import { CATEGORY_COLOR } from "@/lib/category-colors";
import { loadBenchmark } from "@/lib/spec";

export const runtime = "nodejs";
export const alt = "OpenChainBench. Open benchmarks for crypto infrastructure";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// On demand only, same trap as opengraph-image.tsx: non-empty params
// here force build-time prerender of the [slug] page segment.
export async function generateStaticParams() {
  return [];
}

// Mirror opengraph-image: emit one Twitter card per (slug, chain) combo
// so per-chain shares stay honest. See opengraph-image.tsx for the
// motivation; we keep the two layouts identical so a quote-tweet using
// the twitter card matches the link preview when expanded.
export async function generateImageMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const b = await getBenchmark(slug);
  const chains = (b?.dimensions?.chain ?? []).filter(
    (c) => c.value !== "all",
  );
  return [
    {
      id: "default",
      alt,
      size,
      contentType,
    },
    ...chains.map((c) => ({
      id: c.value,
      alt: `${alt}. ${c.label}`,
      size,
      contentType,
    })),
  ];
}

export default async function TwitterImage({
  params,
  id,
}: {
  params: Promise<{ slug: string }>;
  id: Promise<string | number>;
}) {
  const { slug } = await params;
  const rawId = await id;
  const chainId = typeof rawId === "string" && rawId !== "default" ? rawId : null;
  const b = chainId
    ? (await loadBenchmark(slug, { chain: chainId })) ?? (await getBenchmark(slug))
    : await getBenchmark(slug);
  if (!b) return new ImageResponse(<div />, { ...size });

  const top = leader(b);
  const headline = top ? `${top.name} leads at ${fmtUnit(top.value, b.unit)}` : "Awaiting first run";
  const sentence = headlineSentence(b);
  const catColor = CATEGORY_COLOR[b.category] ?? "#7a2e1f";
  const chainLabel = chainId
    ? b.dimensions?.chain?.find((c) => c.value === chainId)?.label ?? chainId
    : null;
  const titleText = chainLabel ? `${b.title} on ${chainLabel}` : b.title;

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
            {chainLabel ? ` · ${chainLabel}` : ""}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: titleText.length > 38 ? 76 : 92,
              fontWeight: 700,
              lineHeight: 0.98,
              letterSpacing: -2,
              maxWidth: 1080,
            }}
          >
            {titleText}
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
