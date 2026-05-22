import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "OpenChainBench press kit. Logos, boilerplate and contact for journalists.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Press kit",
    headline: "Boilerplate, logos, contact.",
    subline:
      "For journalists, podcasters and analysts covering crypto-infra performance. Free to use with attribution.",
  });
}
