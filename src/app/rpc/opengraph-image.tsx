import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
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
