import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "Fastest RPC providers 2026, by chain and region. Live p50/p90/p99 latency and success rate.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "RPC benchmarks",
    headline: "Fastest RPC, by chain and region.",
    subline:
      "p50/p90/p99 latency and success rate for every major RPC provider, probed every 60 seconds from US East, EU West and Singapore.",
  });
}
