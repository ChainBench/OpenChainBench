import { useEffect, useState } from "react";
import { continueRender, delayRender, Img, staticFile } from "remotion";
import type { Theme } from "./theme";

// Mean luminance (0..1) of a logo's opaque pixels, measured once per src
// per browser tab. A dark mark (Mobula's) on the dark chip read as an
// empty square; such logos get a light chip instead.
const lumaCache = new Map<string, Promise<number>>();
const lumaKnown = new Map<string, number>();
function logoLuma(src: string): Promise<number> {
  let p = lumaCache.get(src);
  if (!p) {
    p = new Promise<number>((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = c.height = 32;
          const ctx = c.getContext("2d");
          if (!ctx) return resolve(1);
          ctx.drawImage(img, 0, 0, 32, 32);
          const d = ctx.getImageData(0, 0, 32, 32).data;
          let sum = 0, w = 0;
          for (let i = 0; i < d.length; i += 4) {
            const a = d[i + 3] / 255;
            if (a < 0.3) continue;
            sum += a * (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
            w += a;
          }
          resolve(w ? sum / w : 1);
        } catch {
          resolve(1); // tainted canvas: keep the default chip
        }
      };
      img.onerror = () => resolve(1);
      img.src = src;
    }).then((l) => {
      lumaKnown.set(src, l);
      return l;
    });
    lumaCache.set(src, p);
  }
  return p;
}
const isDarkHex = (hex: string) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 < 0.5;
};

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
  const src = logo ? (/^https?:\/\//.test(logo) ? logo : staticFile(logo)) : null;
  const [luma, setLuma] = useState<number | null>(() => (src ? lumaKnown.get(src) ?? null : null));
  const [handle] = useState(() => (src && luma === null ? delayRender("logo-luma " + src) : null));
  useEffect(() => {
    if (!src || handle === null) return;
    logoLuma(src).then((l) => {
      setLuma(l);
      continueRender(handle);
    });
  }, [src, handle]);
  // 0.33: below that a mark gets under 3:1 contrast on the #15171c chip
  // (Flashbots' grey read at 3% in the lab's contrast check).
  const lightChip = luma !== null && luma < 0.33 && isDarkHex(t.surface);
  if (logo && src && !logoFailed) {
    return (
      <div
        data-lab-chip="logo"
        data-lab-name={name}
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.22,
          background: lightChip ? "#e9ecf1" : t.surface,
          border: `1px solid ${lightChip ? "#e9ecf1" : t.rule}`,
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
          src={src}
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
      data-lab-chip={logo ? "fallback" : "initials"}
      data-lab-name={name}
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
