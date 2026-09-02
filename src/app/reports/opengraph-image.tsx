import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "OpenChainBench reports. In-depth analysis of crypto infrastructure performance backed by live benchmark data.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Reports",
    headline: "Deeper dives, same data.",
    subline:
      "In-depth analysis of crypto infrastructure performance, backed by live benchmark data and open methodology.",
  });
}
