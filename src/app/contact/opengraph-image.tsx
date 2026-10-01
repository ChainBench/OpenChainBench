import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// See the note in docs/opengraph-image.tsx: regenerated once a day, not
// once per unfurl.
export const revalidate = 86400;
export const alt = "Contact OpenChainBench. Correct a number, correct a provider entry, or propose a benchmark.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Contact",
    headline: "Tell us what is wrong.",
    subline:
      "A number that does not reproduce, a provider entry to correct, a benchmark worth adding, or anything else.",
  });
}
