import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "OpenChainBench — Open benchmarks for crypto infrastructure";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function TwitterImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#faf6ee",
          color: "#1c1a17",
          padding: 60,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          fontFamily: "Georgia, serif",
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
          <span>Vol. I · Issue 001</span>
          <span>Open · Reproducible · Independent</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 22,
              letterSpacing: 6,
              textTransform: "uppercase",
              color: "#7a2e1f",
              marginBottom: 12,
            }}
          >
            A field journal of crypto-infrastructure performance
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 132,
              fontWeight: 700,
              lineHeight: 0.95,
              letterSpacing: -2,
            }}
          >
            OpenChainBench
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 32,
              fontStyle: "italic",
              color: "#4a443c",
              marginTop: 16,
              maxWidth: 1080,
            }}
          >
            Latency, accuracy &amp; reliability — measured in the open.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderTop: "2px solid #1c1a17",
            paddingTop: 20,
            fontSize: 18,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: "#1c1a17",
          }}
        >
          <span>openchainbench.xyz</span>
          <span>@openchainbench</span>
        </div>
      </div>
    ),
    { ...size }
  );
}
