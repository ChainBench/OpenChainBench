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

  // Brand marks come in two failure modes against our page background:
  //   • dark-on-transparent → invisible on dark-mode page         → light chip
  //   • white-on-transparent → invisible on white light-mode page → dark chip
  // Each problematic slug is opted in to ONE of the two sets below. Logos
  // with proper colored fills (Helius orange, GeckoTerminal purple, …)
  // need neither and ride the default transparent paper background.
  const lc = slug.toLowerCase();
  const needsLightChip = NEEDS_LIGHT_CHIP.has(lc);
  const needsDarkChip = NEEDS_DARK_CHIP.has(lc);
  let background: string;
  let boxShadow: string | undefined;
  if (needsDarkChip) {
    background = "#0f172a";
    boxShadow = "0 0 0 1px rgba(15, 23, 42, 0.18)";
  } else if (needsLightChip) {
    background = "#ffffff";
    boxShadow = "0 0 0 1px rgba(15, 23, 42, 0.08)";
  } else {
    background = "var(--color-paper)";
    boxShadow = undefined;
  }

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
        background,
        boxShadow,
      }}
    />
  );
}

// Dark-tone (or dark-on-transparent) logos — get a WHITE chip with a
// hairline shadow so they pop on both light and dark page backgrounds.
const NEEDS_LIGHT_CHIP = new Set([
  // Ten-chain sweep 2026-10-07: these two ship only a monochrome mask,
  // which is invisible on a dark page without a chip behind it.
  "neox",
  "superseed",
  // On-ramp marks (bench 262): dark monochrome brand assets.
  "moonpay",
  "meld",
  "mercuryo",
  "onramper",
  "aptos",
  "slash",
  "markets-mobile",
  "aapl",
  "pltr",
  "leorpc",
  "blinklabs",
  "mobula",
  "lighter",
  "stellar",
  "stellarexpert",
  "relay",
  "debridge",
  "tonapi",
  "1rpc",
  "lava",
  "tenderly",
  "merkle",
  "moralis",
  "nodies",
  "zerion",
  // Bench 284. OpenAI's and Anthropic's marks are single black paths on
  // transparent, so they vanish on a dark page. The Gemini sparkle carries its
  // own gradient and the Grok mark its own dark tile, so neither is listed.
  // The agent slugs are listed alongside the lab slugs because this lookup
  // runs on the slug the caller passes, before the logo manifest aliases it.
  "openai",
  "anthropic",
  "gpt-52-chart",
  "gpt-52-vision",
  "opus-45-chart",
  "sonnet-45-vision",
]);

// White-on-transparent logos — invisible on a white chip. They get a
// near-black chip so the white artwork pops. Verified via SVG fill audit
// (fill="white" present in the brand mark).
const NEEDS_DARK_CHIP = new Set([
  // Ramp Network sign: off-white R on transparent.
  "ramp",
  "jito",
  "astralane",
  "sky",
  "dydx",
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
