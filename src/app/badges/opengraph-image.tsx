import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
export const alt = "OpenChainBench live ranking badges. Embed a live benchmark rank badge in your docs or README.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Badges",
    headline: "Show your live rank.",
    subline:
      "Embed a live OpenChainBench ranking badge in your docs, README or website. Updates automatically as benchmark data changes.",
  });
}
