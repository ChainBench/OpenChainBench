import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Share cards change slowly and crawlers fetch them constantly, so the
// satori render is cached for a day rather than run per request.
export const revalidate = 86400;
export const alt =
  "OpenChainBench tools. Calculators that take your own position, wallet or connection and answer for it.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Tools",
    headline: "Tools that take your numbers.",
    subline:
      "A benchmark ranks a cohort. These answer for your own position, wallet or connection, on the same measurements.",
  });
}
