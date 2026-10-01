import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Share cards change slowly; crawlers and link unfurlers fetch them
// constantly. Without a revalidate the image is regenerated (satori,
// ~1-2 s of CPU) on every request.
export const revalidate = 86400;
export const alt = "OpenChainBench docs. MCP server, REST API, Markdown views and citation formats.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "Docs",
    headline: "Readable without a browser.",
    subline:
      "One MCP server with four tools, eleven REST endpoints, every page as Markdown, and the data under CC BY 4.0.",
  });
}
