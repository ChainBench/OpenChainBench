import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
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
