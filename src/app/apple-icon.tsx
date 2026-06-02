import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 180×180 is the Apple Touch Icon size iOS Safari pins to the home screen
// and most non-Google crawlers fall back to when /apple-icon is requested
// (separate file from /icon, which we already ship at 64×64 for the browser
// tab favicon). Without this Apple devices show a blurry screenshot of the
// page instead of the brand mark.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  const logoBuffer = readFileSync(join(process.cwd(), "public", "logo.png"));
  const logoDataUrl = `data:image/png;base64,${logoBuffer.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: 180,
          height: 180,
          background: "#f8f3eb",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <img
          src={logoDataUrl}
          alt="OpenChainBench"
          width={148}
          height={148}
          style={{ objectFit: "contain" }}
        />
      </div>
    ),
    { ...size },
  );
}
