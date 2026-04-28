import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "OpenChainBench — Benchmark crypto infrastructure";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function TwitterImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#f7f6f3",
          color: "#0a0a0a",
          padding: 70,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: -1.4 }}>
            OpenChainBench
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 124,
              fontWeight: 700,
              lineHeight: 0.96,
              letterSpacing: -3,
            }}
          >
            Benchmark crypto infrastructure.
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 28,
              color: "#525252",
              marginTop: 22,
              maxWidth: 980,
            }}
          >
            Open, reproducible benchmarks for the multichain stack.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingTop: 22,
            borderTop: "1px solid #e7e5e0",
            fontSize: 16,
            color: "#525252",
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
