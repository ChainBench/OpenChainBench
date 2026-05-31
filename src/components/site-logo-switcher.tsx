"use client";

/**
 * Hybrid masthead logo: 2D SVG on touch / small screens, interactive 3D
 * sphere on desktop. The 3D bundle is loaded with `next/dynamic` so it
 * only ships when actually mounted.
 *
 * Three layers stacked in the same slot:
 *  1. `<SiteLogo>` (logo-touch-only) — the full brand SVG with corner
 *     triangles; visible on touch / small screens only.
 *  2. `<SpherePlaceholder>` (logo-desktop-only) — a tiny static SVG of
 *     a sphere with the C-mark centred; paints instantly on desktop's
 *     first frame, so the slot is never blank while the 3D chunk loads.
 *  3. `<SiteLogo3D>` — mounted once enable3D + chunk are ready; covers
 *     the placeholder byte-for-byte (same circular silhouette), so the
 *     swap is visually invisible.
 *
 * Detection: `(pointer: fine) and (min-width: 768px)`. Touchscreen
 * laptops with a mouse still qualify as desktop.
 */

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { SiteLogo } from "@/components/site-logo";

const DESKTOP_MQ = "(pointer: fine) and (min-width: 768px)";

const SiteLogo3D = dynamic(
  () => import("@/components/site-logo-3d").then((m) => m.SiteLogo3D),
  { ssr: false, loading: () => null },
);

/**
 * Static SVG that mimics the 3D sphere's silhouette + centred C-mark.
 * Identical proportions to <SiteLogo3D> so the real 3D canvas can
 * cover this byte-for-byte without a visible transition.
 */
function SpherePlaceholder({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      {/* Sphere body — matches --color-surface so it blends with the
          header just like the 3D sphere does. */}
      <circle cx="50" cy="50" r="42" fill="var(--color-surface)" />
      {/* C-mark centred inside the sphere — same geometry as <SiteLogo>
          (cx=45 cy=50 r=45, inner ellipse rx=22 ry=40, right rect),
          scaled to ~55% so it sits in the visible front face the same
          way it does on the 3D sphere. */}
      <g transform="translate(50 50) scale(0.55) translate(-45 -50)">
        <mask id="site-logo-3d-fallback-mask">
          <rect width="100" height="100" fill="white" />
          <ellipse cx="45" cy="50" rx="22" ry="40" fill="black" />
          <rect x="45" y="38" width="55" height="24" fill="black" />
        </mask>
        <circle
          cx="45"
          cy="50"
          r="45"
          fill="var(--color-ink)"
          mask="url(#site-logo-3d-fallback-mask)"
        />
      </g>
    </svg>
  );
}

export function SiteLogoSwitcher({ size = 22 }: { size?: number }) {
  const [enable3D, setEnable3D] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_MQ);
    const sync = () => setEnable3D(mq.matches);
    sync();
    mq.addEventListener("change", sync);

    // Eagerly fetch the 3D chunk on desktop so it is in the browser
    // cache by the time React tries to mount <SiteLogo3D>.
    if (mq.matches) import("@/components/site-logo-3d");

    return () => mq.removeEventListener("change", sync);
  }, []);

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div className="absolute inset-0 logo-touch-only">
        <SiteLogo size={size} />
      </div>
      <div className="absolute inset-0 logo-desktop-only">
        <SpherePlaceholder size={size} />
      </div>
      {enable3D && (
        <div className="absolute inset-0">
          <SiteLogo3D size={size} />
        </div>
      )}
    </div>
  );
}
