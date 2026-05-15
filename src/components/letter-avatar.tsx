/**
 * Round letter avatar used in product listings. Looks up a registered
 * brand color first, falls back to a deterministic slate-leaning palette
 * hashed from the slug so the same product always renders the same hue.
 *
 * White letter centered, with a thin ring around white/very-light fills
 * so they remain visible on a white page.
 */

import { brandColor, isLight } from "@/lib/brand";

const FALLBACK_PALETTE = [
  "#475569", // slate-600
  "#0f172a", // slate-900
  "#334155", // slate-700
  "#1e293b", // slate-800
  "#64748b", // slate-500
];

// A few well-known overrides the design calls for explicitly.
const OVERRIDES: Record<string, string> = {
  mobula: "#ffffff",
  codex: "#D6FF00",
  geckoterminal: "#8B5CF6",
  lighter: "#000000",
  ton: "#0EA5E9",
};

function hashIndex(slug: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) {
    h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return h % mod;
}

function firstLetter(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]/g, "");
  return (cleaned[0] ?? "?").toUpperCase();
}

export function LetterAvatar({
  slug,
  name,
  size = 48,
  className = "",
}: {
  slug: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const key = slug.toLowerCase();
  const bg =
    OVERRIDES[key] ??
    brandColor(slug) ??
    FALLBACK_PALETTE[hashIndex(key, FALLBACK_PALETTE.length)];

  const light = isLight(bg);
  const fg = light ? "var(--color-ink)" : "#ffffff";
  // Light/white fills get a hairline border so they don't dissolve into the page.
  const ring = light ? "1px solid var(--color-rule-strong)" : "none";

  return (
    <span
      className={`shrink-0 inline-flex items-center justify-center rounded-full font-semibold leading-none select-none ${className}`}
      style={{
        width: size,
        height: size,
        background: bg,
        color: fg,
        border: ring,
        fontSize: Math.round(size * 0.42),
        letterSpacing: "0.01em",
      }}
      aria-label={`${name} avatar`}
    >
      {firstLetter(name)}
    </span>
  );
}
