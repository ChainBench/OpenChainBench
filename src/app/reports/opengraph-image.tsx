import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
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
