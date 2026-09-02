import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "Compare crypto infrastructure providers head to head. Live benchmark data, no vendor claims.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Compare",
    headline: "Providers, head to head.",
    subline:
      "Pick any two infrastructure providers and compare them on latency, reliability and cost. Live data, no vendor claims.",
  });
}
