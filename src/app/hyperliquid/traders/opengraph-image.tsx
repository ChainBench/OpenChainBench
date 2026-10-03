import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Same reasoning as the hub card: unfurlers fetch these constantly and
// satori costs ~1-2 s of CPU per render, while the content changes daily
// at most.
export const revalidate = 86400;
export const alt =
  "Audit of Hyperliquid's published trader leaderboard: accounts claiming profit on zero volume, an aggregate that cannot be, and ROI without a denominator.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Hyperliquid",
    headline: "The leaderboard, audited.",
    subline:
      "Hyperliquid publishes PnL for tens of thousands of accounts. Thousands of them claim profit on no volume, and the aggregate cannot be what it says.",
  });
}
