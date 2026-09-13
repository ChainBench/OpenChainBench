import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
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
