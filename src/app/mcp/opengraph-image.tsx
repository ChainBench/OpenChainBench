import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
export const alt = "OpenChainBench MCP server. Live crypto-infra benchmarks for Claude, Cursor and ChatGPT.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OG() {
  return renderHubOG({
    kicker: "MCP server",
    headline: "Benchmarks, as a tool for your AI assistant.",
    subline:
      "Connect Claude Desktop, Cursor, ChatGPT or any MCP-capable agent. Every live benchmark becomes a typed tool.",
  });
}
