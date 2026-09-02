import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "Chains tracked by OpenChainBench. Browse all live benchmarks grouped by blockchain.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Chains",
    headline: "Every chain we measure.",
    subline:
      "All blockchains tracked by OpenChainBench. Pick a chain for the full set of live RPC, finality and data measurements.",
  });
}
