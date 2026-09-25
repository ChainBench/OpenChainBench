import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const revalidate = 86400;
export const alt = "Capital flows and token valuation leaderboards: TVL, bridged value, stablecoin flows, open interest, price to fees.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Capital",
    headline: "Where the capital moves, what the tokens cost.",
    subline:
      "TVL, bridged value and stablecoin flows per chain; open interest; price to fees and price to sales per token, against category medians. Public data, daily history.",
  });
}
