"use client";

import { useState } from "react";
import { chipBackground, chipTextColor, initials } from "@/lib/brand";
import { logoPath } from "@/lib/logo-manifest";

/**
 * Renders an entity's logo as a small circular image. Tries the registered
 * file under `public/logos/<slug>.<ext>` first; on missing file or load
 * error, falls back to a colored chip with the entity's initials painted
 * over the brand color.
 *
 * Kept slug-driven (not path-driven) so adding a new logo is just a
 * matter of dropping a file in `public/logos/` and registering it in
 * `logo-manifest.ts` - every consumer picks it up automatically.
 */
export function ProviderLogo({
  slug,
  name,
  size = 22,
  className = "",
}: {
  slug: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const src = logoPath(slug);
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return <Chip slug={slug} name={name} size={size} className={className} />;
  }

  // A handful of brand marks are dark-on-transparent and disappear on the
  // dark-mode page background. Force a white coaster + thin ring for those
  // specific slugs so they stay legible without altering the look of every
  // other (already-colored) logo.
  const needsLightChip = NEEDS_LIGHT_CHIP.has(slug.toLowerCase());

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={`${name} logo`}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`shrink-0 object-contain ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: needsLightChip ? "#ffffff" : "var(--color-paper)",
        boxShadow: needsLightChip ? "0 0 0 1px rgba(15, 23, 42, 0.08)" : undefined,
      }}
    />
  );
}

const NEEDS_LIGHT_CHIP = new Set([
  "mobula",
  "lighter",
  "stellar",
  "stellarexpert",
  "relay",
  "debridge",
  "tonapi",
  // Dark/single-tone logos that need a white chip to read on the page bg:
  "1rpc",
  "blocknative",
  "lava",
  "tenderly",
  "jito",
  "astralane",
  "dydx",
  "sky",
]);

function Chip({
  slug,
  name,
  size,
  className,
}: {
  slug: string;
  name: string;
  size: number;
  className: string;
}) {
  return (
    <span
      className={`shrink-0 inline-flex items-center justify-center rounded-full font-semibold leading-none ${className}`}
      style={{
        width: size,
        height: size,
        background: chipBackground(slug),
        color: chipTextColor(slug),
        fontSize: Math.round(size * 0.42),
        letterSpacing: "0.02em",
      }}
      aria-label={`${name} (no logo)`}
    >
      {initials(name)}
    </span>
  );
}
