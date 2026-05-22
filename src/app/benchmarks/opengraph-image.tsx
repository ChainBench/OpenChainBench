import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "All OpenChainBench benchmarks. Live performance across crypto infrastructure.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "All benchmarks",
    headline: "Every live benchmark, in one place.",
    subline:
      "Aggregators, bridges, RPCs, oracles, trading venues, blockchains. p50, p90, p99 refreshed every minute.",
  });
}
