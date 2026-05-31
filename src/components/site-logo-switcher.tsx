"use client";

/**
 * Hybrid masthead logo: 2D SVG on touch / small screens, interactive 3D
 * sphere on desktop. The 3D bundle is loaded with `next/dynamic` so it
 * only ships when actually mounted.
 *
 * No-flash strategy: the SVG renders unconditionally in the same slot
 * as a layered fallback. The 3D component overlays it once mounted and
 * fully covers it, so the swap is visually seamless — no blank state
 * and no visible SVG→3D pop. While the chunk is downloading, the SVG
 * underneath is exactly what the user already saw at first paint.
 *
 * Detection: `(pointer: fine) and (min-width: 768px)` — real mouse on
 * a viewport ≥ 768px. Touchscreen laptops with a mouse still get 3D.
 */

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { SiteLogo } from "@/components/site-logo";

const DESKTOP_MQ = "(pointer: fine) and (min-width: 768px)";

const SiteLogo3D = dynamic(
  () => import("@/components/site-logo-3d").then((m) => m.SiteLogo3D),
  // No loading element — the always-rendered SVG below is the fallback,
  // so we render nothing here to avoid a double layer during the load.
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
    // cache by the time React tries to mount <SiteLogo3D> — keeps the
    // SVG→3D handover under a frame in the common case.
    if (mq.matches) import("@/components/site-logo-3d");

    return () => mq.removeEventListener("change", sync);
  }, []);

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
    >
      <div className="absolute inset-0">
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
