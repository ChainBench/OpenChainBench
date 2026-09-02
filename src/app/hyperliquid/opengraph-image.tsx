import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "Hyperliquid frontends and HIP-3 DEX leaderboard. Live revenue, volume and users from a local HL node.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Hyperliquid",
    headline: "Every HL frontend, ranked.",
    subline:
      "Revenue, volume and daily users for every Hyperliquid frontend and HIP-3 deployer. Server-side data from a local node tailing every fill.",
  });
}
