import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
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
