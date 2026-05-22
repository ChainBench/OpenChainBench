import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
export const alt = "Contribute a benchmark to OpenChainBench. Six steps from idea to live spec.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Contribute",
    headline: "Publish your own benchmark.",
    subline:
      "Six steps. Open an issue, write the spec, build the harness, host it, wire the scrape, open a PR. Reviewed in public.",
  });
}
