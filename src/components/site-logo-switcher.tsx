"use client";

/**
 * Hybrid masthead logo: 2D SVG on touch / small screens, interactive 3D
 * sphere on desktop.
 *
 * The 3D component is imported statically (not via next/dynamic) so the
 * sphere mounts as soon as the main JS executes — no separate chunk to
 * download. Trade-off: the three.js code ends up in the shared client
 * bundle (~150 KB gz), which mobile users also fetch even though they
 * never mount the component. Worth it because the previous dynamic
 * setup left a visible blank slot while the chunk loaded.
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
import { SiteLogo } from "@/components/site-logo";
import { SiteLogo3D } from "@/components/site-logo-3d";

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
