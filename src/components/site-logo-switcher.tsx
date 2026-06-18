"use client";

/**
 * Hybrid masthead logo: 2D SVG on touch / small screens, interactive 3D
 * sphere on desktop.
 *
 * The 3D component is loaded via `next/dynamic` with `ssr: false` so the
 * three.js + @react-three/fiber payload is never sent to mobile / touch
 * users (the desktop media query has to match before the chunk is even
 * requested). The SSR fallback is the 2D SVG, which paints immediately
 * and stays visible underneath until the 3D chunk hydrates on top — so
 * the masthead never shows a blank slot.
 *
 * Layering:
 *  - `<SiteLogo>` (logo-touch-only) — the full brand SVG with corner
 *    triangles; visible on touch / small screens only.
 *  - `<SiteLogo3D>` — overlaid on top once enable3D flips to true on
 *    desktop. The SVG is CSS-hidden on desktop (`logo-touch-only`) so
 *    nothing ever paints alongside the 3D there.
 *
 * Detection: `(pointer: fine) and (min-width: 768px)`. Touchscreen
 * laptops with a mouse still qualify as desktop.
 */

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { SiteLogo } from "@/components/site-logo";

const SiteLogo3D = dynamic(
  () => import("@/components/site-logo-3d").then((m) => m.SiteLogo3D),
  { ssr: false, loading: () => null },
);

const DESKTOP_MQ = "(pointer: fine) and (min-width: 768px)";

export function SiteLogoSwitcher({ size = 22 }: { size?: number }) {
  const [enable3D, setEnable3D] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_MQ);
    const sync = () => setEnable3D(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
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
