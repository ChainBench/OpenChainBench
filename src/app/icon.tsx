import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 64,
          height: 64,
          background: "#0a0a0a",
          color: "#f7f6f3",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 30,
          fontWeight: 700,
          letterSpacing: -2,
          fontFamily: "Inter, system-ui, sans-serif",
          borderRadius: 14,
        }}
      >
        OCB
      </div>
    ),
    { ...size }
  );
}
