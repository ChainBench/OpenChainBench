import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "All OpenChainBench products. Crypto infrastructure providers ranked across live benchmarks.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "All products",
    headline: "Every measured provider, ranked.",
    subline:
      "Aggregators, RPCs, bridges, oracles, indexers. Wins, appearances, and where they rank across the catalogue.",
  });
}
