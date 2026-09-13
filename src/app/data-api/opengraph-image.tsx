import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
export const alt = "Best crypto data API 2026. Live benchmark ranking of price, NFT and DeFi data providers by latency and accuracy.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Data API benchmarks",
    headline: "Best crypto data API, ranked.",
    subline:
      "Latency, accuracy and reliability for every major crypto data API provider. Measured continuously from three regions.",
  });
}
