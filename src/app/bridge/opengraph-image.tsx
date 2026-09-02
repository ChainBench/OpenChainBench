import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "Cheapest cross-chain bridge 2026. Live fee and slippage ranking across Across, deBridge, LI.FI, Relay and more.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Bridge benchmarks",
    headline: "Cheapest cross-chain bridge, live.",
    subline:
      "All-in fee (fees + slippage + destination gas) for $300 USDC across Solana, Base and Arbitrum corridors. Refreshed every 5 minutes.",
  });
}
