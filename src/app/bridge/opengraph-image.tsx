import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
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
