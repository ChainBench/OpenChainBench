import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "OpenChainBench partners and integrations. Projects that embed or reference our open benchmark data.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Partners",
    headline: "Partners and integrations.",
    subline:
      "Projects and documentation sites that embed or reference OpenChainBench benchmark data in their products.",
  });
}
