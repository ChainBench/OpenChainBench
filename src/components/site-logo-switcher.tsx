"use client";

/**
 * Hybrid logo switcher: the 2D SVG <SiteLogo> on touch devices (phones,
 * tablets), the interactive 3D sphere <SiteLogo3D> on desktop.
 *
 * The 3D component is loaded with `next/dynamic` and `ssr: false`, so
 * touch users never download the three.js chunk — they only ship the
 * tiny SVG. Desktop users get the chunk on demand after first paint.
 *
 * Detection rule: `(pointer: fine) and (min-width: 768px)`. This means
 * a real mouse/trackpad on a viewport ≥ 768px. Touchscreen laptops with
 * a mouse still qualify as desktop; phones and tablets do not.
 */

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { SiteLogo } from "@/components/site-logo";

const SiteLogo3D = dynamic(
  () => import("@/components/site-logo-3d").then((m) => m.SiteLogo3D),
  { ssr: false, loading: () => <SiteLogo size={22} /> },
);

const DESKTOP_MQ = "(pointer: fine) and (min-width: 768px)";

export function SiteLogoSwitcher({ size = 22 }: { size?: number }) {
  // Render the SVG fallback during SSR / first client paint so the
  // markup never flashes, then upgrade to 3D on desktop after mount.
  const [enable3D, setEnable3D] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_MQ);
    const sync = () => setEnable3D(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return enable3D ? <SiteLogo3D size={size} /> : <SiteLogo size={size} />;
}
