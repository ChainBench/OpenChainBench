import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
export const alt = "Perp DEX fee comparison. Compare taker fees between any two venues using real on-chain wallet data.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Fee compare",
    headline: "Perp DEX fees, head to head.",
    subline:
      "Paste a wallet and compare what you paid on Hyperliquid or Gains against any other venue. Live on-chain data, no API key.",
  });
}
