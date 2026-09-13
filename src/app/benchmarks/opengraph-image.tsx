import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
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
