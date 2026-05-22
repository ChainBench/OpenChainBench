import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";

export const runtime = "nodejs";
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
