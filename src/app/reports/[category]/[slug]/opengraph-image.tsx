import { ImageResponse } from "next/og";
import { getReport } from "@/lib/reports/loader";

export const runtime = "nodejs";
export const alt = "OpenChainBench Research Report";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export async function generateStaticParams() {
  return [];
}

export default async function OG({
  params,
}: {
  params: Promise<{ category: string; slug: string }>;
}) {
  const { category, slug } = await params;
  const report = getReport(category, slug);
  if (!report) return new ImageResponse(<div />, { ...size });

  const title = report.title;
  const fontSize = title.length > 60 ? 58 : title.length > 40 ? 68 : 80;

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
          <span>OpenChainBench · Research Report</span>
          <span style={{ color: "#7a2e1f" }}>{report.period}</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 20,
              letterSpacing: 6,
              textTransform: "uppercase",
              color: "#7a2e1f",
              marginBottom: 16,
            }}
          >
            {report.category}
          </div>
          <div
            style={{
              display: "flex",
              fontSize,
              fontWeight: 700,
              lineHeight: 1.0,
              letterSpacing: -2,
              maxWidth: 1080,
            }}
          >
            {title}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 26,
              fontStyle: "italic",
              color: "#4a443c",
              marginTop: 20,
              maxWidth: 1080,
              lineHeight: 1.4,
            }}
          >
            {report.heroFinding.length > 140
              ? report.heroFinding.slice(0, 137) + "..."
              : report.heroFinding}
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
          <span>openchainbench.com/reports</span>
          <span>{report.author}</span>
        </div>
      </div>
    ),
    { ...size }
  );
}
