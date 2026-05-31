"use client";

/**
 * Hybrid masthead logo: 2D SVG on touch / small screens, interactive 3D
 * sphere on desktop. The 3D bundle is loaded with `next/dynamic` so it
 * only ships when actually mounted.
 *
 * Desktop never shows the SVG. A pure-CSS media-query gate in globals.css
 * (`.logo-touch-only { display: none }` under `pointer: fine` + ≥ 768px)
 * keeps the SSR-painted SVG off the screen on real-mouse viewports, so
 * the only thing the user ever sees there is the 3D sphere (with a tiny
 * empty slot while the chunk loads — eagerly fetched on mount to keep
 * that gap under one frame in the common case).
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
      {/* SVG fallback — hidden on desktop via the `.logo-touch-only`
          rule in globals.css so it never paints alongside the 3D. */}
      <div className="absolute inset-0 logo-touch-only">
        <SiteLogo size={size} />
      </div>
      {enable3D && (
        <div className="absolute inset-0">
          <SiteLogo3D size={size} />
        </div>
      )}
    </div>
  );
}
