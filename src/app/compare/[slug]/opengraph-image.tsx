import { ogResponse } from "@/lib/og-response";
import { getComparePair } from "@/data/compare-pairs";
import { canonicalize } from "@/lib/providers";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
export const alt = "OpenChainBench. Open benchmarks for crypto infrastructure";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OG({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const pair = getComparePair(slug);
  if (!pair) return ogResponse(<div />, { ...size });

  const a = canonicalize(pair.providerA).name;
  const b = canonicalize(pair.providerB).name;
  const title = `${a} vs ${b}`;

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
          <span>OpenChainBench · Head to head</span>
          <span style={{ color: "#6a9466" }}>Live benchmark data</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: title.length > 22 ? 96 : 130,
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
            Side by side on every shared benchmark. Live measurements, no
            verdict.
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
          <span>openchainbench.com/compare/{pair.slug}</span>
          <span style={{ fontFamily: "Georgia, serif", letterSpacing: 2 }}>
            Measured, not sponsored
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
