import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "OpenChainBench answers. Common questions about crypto infrastructure, answered with live benchmark data.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Answers",
    headline: "Questions, answered with data.",
    subline:
      "Common questions about crypto infrastructure performance, answered directly from live OpenChainBench benchmark results.",
  });
}
