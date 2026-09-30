import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
export const alt = "Hyperliquid frontends and HIP-3 DEX leaderboard. Live revenue, volume and users from a local HL node.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Hyperliquid",
    headline: "Every HL frontend, ranked.",
    subline:
      "Revenue, volume and daily users for every Hyperliquid frontend, volume and open interest for every HIP-3 dex. From Hyperliquid's public feeds.",
  });
}
