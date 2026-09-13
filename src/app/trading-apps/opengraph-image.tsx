import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
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
