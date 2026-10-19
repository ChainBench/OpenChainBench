import { useState } from "react";
import { Img, staticFile } from "remotion";
import type { Theme } from "./theme";

/**
 * Reusable provider lockup: logo chip + name. Reused across every race
 * composition so the visual treatment of a provider is identical
 * whether the viewer is watching a bar race or a podium reveal.
 *
 * When `logo` is missing the chip falls back to the provider's brand
 * colour with first two letters of the name in the contrasting ink.
 */

export const ProviderChip: React.FC<{
  name: string;
  color: string;
  logo?: string;
  size?: number;
  theme: Theme;
}> = ({ name, color, logo, size = 48, theme: t }) => {
  // A logo that fails to load falls back to the initials chip instead of
  // failing the render or leaving an empty square.
  const [logoFailed, setLogoFailed] = useState(false);
  if (logo && !logoFailed) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.22,
          background: t.surface,
          border: `1px solid ${t.rule}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <Img
          // Remotion's <Img> holds the frame until the image has loaded; a
          // plain <img> did not, so the outro leader showed an empty square.
          // Bundle assets need staticFile() to resolve against serveUrl;
          // absolute URLs (https://…) are passed through unchanged because
          // staticFile() rejects them at runtime.
          src={/^https?:\/\//.test(logo) ? logo : staticFile(logo)}
          alt={name}
          crossOrigin="anonymous"
          maxRetries={2}
          onError={() => setLogoFailed(true)}
          style={{
            width: size * 0.78,
            height: size * 0.78,
            objectFit: "contain",
          }}
        />
      </div>
    );
  }

  // Initials fallback
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.22,
        background: color,
        color: "#000000",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.42,
        fontWeight: 800,
        letterSpacing: "-0.03em",
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  );
};
