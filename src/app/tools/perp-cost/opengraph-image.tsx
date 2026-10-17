import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const revalidate = 86400;
export const alt =
  "Perp leverage cost. What ten perp venues take from the same leveraged trade, and where a fee on the gain beats a fee on notional.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Perp leverage cost",
    headline: "What a leveraged trade costs you.",
    subline:
      "Nine venues charge a share of notional, twice. One charges a share of the gain, once. Drag the price move and the order changes.",
  });
}
