import type { MetadataRoute } from "next";

// PWA manifest. Lets browsers offer "Add to Home Screen" on mobile and
// gives chromium / safari a theme color for the URL bar. Also picked up
// by aggregators (Twitter / Discord / Slack) when generating link cards.
// /icon and /apple-icon are emitted by their respective app-router files.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OpenChainBench",
    short_name: "OpenChainBench",
    description: "Open, reproducible benchmarks for crypto infrastructure.",
    start_url: "/",
    display: "standalone",
    background_color: "#f8f3eb",
    theme_color: "#7a2e1f",
    icons: [
      { src: "/icon", sizes: "64x64", type: "image/png" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
