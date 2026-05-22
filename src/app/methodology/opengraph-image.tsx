import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "OpenChainBench methodology. Design principles, conventions, reproduction guide.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Methodology",
    headline: "How every number on this site is measured.",
    subline:
      "Design principles, statistical conventions and a reproduction guide. Every claim is checkable against the spec, harness and Prometheus dataset.",
  });
}
