import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "Best Solana trading apps 2026. Live leaderboard ranked by volume, wallets, fees and app store ratings.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Trading apps",
    headline: "Best Solana trading app, live.",
    subline:
      "Volume, active wallets, fees and app store ratings across every major Solana trading venue. Benchmarks updated continuously.",
  });
}
