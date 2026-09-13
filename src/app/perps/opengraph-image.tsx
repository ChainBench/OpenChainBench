import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
export const alt = "Best perp DEX 2026. Live leaderboard of perpetual exchanges by volume, open interest, fees and funding.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Perp DEX leaderboard",
    headline: "Best perp DEX, by the numbers.",
    subline:
      "Volume, open interest, all-in cost and funding rate across every major perpetual exchange. Updated continuously.",
  });
}
