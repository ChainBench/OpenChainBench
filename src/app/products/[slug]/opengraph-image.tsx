import { distinctBenchCount } from "@/lib/providers";
import { ogResponse } from "@/lib/og-response";
import { getProvider } from "@/lib/providers";
import { OgHighlight } from "@/lib/og-claim";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
export const alt = "OpenChainBench. Open benchmarks for crypto infrastructure";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Rendered ON DEMAND, same reasoning as the product page: prerendering
// ~200 OG images at build multiplies the full Prom load per build worker
// and was the last route standing in failed builds.
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return [];
}

export default async function OG({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const p = await getProvider(slug);
  if (!p) return ogResponse(<div />, { ...size });

  const top1Line =
    p.wins > 0
      ? `#1 on ${p.wins} benchmark${p.wins === 1 ? "" : "s"}`
      : "Tracked across the leaderboard";
  const appearancesLine = `${distinctBenchCount(p.appearances)} benchmark${distinctBenchCount(p.appearances) === 1 ? "" : "s"} measured`;
  const accent = p.wins > 0 ? "#6a9466" : "#7a7166";

  return ogResponse(
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
          <OgHighlight
            lead={
              p.wins > 0
                ? `#1 on ${p.wins} of ${distinctBenchCount(p.appearances)} benchmark${distinctBenchCount(p.appearances) === 1 ? "" : "s"}`
                : appearancesLine
            }
            rest={p.wins > 0 ? "measured live on OpenChainBench" : "on OpenChainBench"}
          />
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
