import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "OpenChainBench team. The people building open benchmarks for crypto infrastructure.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Team",
    headline: "The people behind the bench.",
    subline:
      "Building open, reproducible benchmarks for crypto infrastructure. Community-run, no vendor funding.",
  });
}
