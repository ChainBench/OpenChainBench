import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "About OpenChainBench. Open benchmarks for crypto infrastructure.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "About",
    headline: "Open, reproducible benchmarks for crypto infrastructure.",
    subline:
      "Measured in the open, published in the same format every time. So builders can choose providers on data, not marketing.",
  });
}
