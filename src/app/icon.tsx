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
          background: "#1c1a17",
          color: "#faf6ee",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 30,
          fontWeight: 800,
          letterSpacing: -1,
          fontFamily: "Georgia, serif",
        }}
      >
        OCB
      </div>
    ),
    { ...size }
  );
}
