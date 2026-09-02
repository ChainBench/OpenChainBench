import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "Alternatives to crypto infrastructure products, ranked by live OpenChainBench benchmarks.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Alternatives",
    headline: "Alternatives, by the numbers.",
    subline:
      "Benchmark-ranked alternatives to every major crypto infrastructure product. Same data, reframed per product, no verdict.",
  });
}
