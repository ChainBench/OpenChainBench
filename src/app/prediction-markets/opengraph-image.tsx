import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "Prediction markets leaderboard 2026. Volume, resolution delay, API latency and data freshness across every major venue.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Prediction markets",
    headline: "Prediction markets, ranked live.",
    subline:
      "Volume, resolution delay, API latency and data freshness across Polymarket, Kalshi and every other major venue.",
  });
}
