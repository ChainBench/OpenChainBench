/**
 * Public AI brief. Served at /contribute/ai-brief.md.
 *
 * Read the canonical SKILL.md at build time and strip its YAML
 * frontmatter so the body can be pasted into any LLM tool (ChatGPT,
 * Claude, Cursor, Aider, Codex). The same content powers the
 * .claude/skills/contribute-benchmark skill and the version published
 * on ClawHub. one source, three surfaces.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { SITE } from "@/data/site";

export const dynamic = "force-static";
export const revalidate = 3600;

function stripFrontmatter(src: string): string {
  if (!src.startsWith("---")) return src;
  const end = src.indexOf("\n---", 3);
  if (end === -1) return src;
  return src.slice(end + 4).replace(/^\n+/, "");
}

export async function GET() {
  const skillPath = path.join(
    process.cwd(),
    ".claude/skills/contribute-benchmark/SKILL.md",
  );
  let body = "";
  try {
    body = await fs.readFile(skillPath, "utf8");
  } catch {
    body = "# AI brief\n\nSkill source not found.";
  }
  const md = stripFrontmatter(body);
  const header = [
    "# OpenChainBench AI brief for contributors",
    "",
    "Paste this entire document into your AI tool of choice. Then ask",
    "for help drafting a spec, a harness, or a PR.",
    "",
    `Source: ${SITE.url}/contribute/ai-brief.md`,
    "Repo:   https://github.com/ChainBench/OpenChainBench",
    "",
    "---",
    "",
  ].join("\n");
  return new Response(header + md, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=7200",
    },
  });
}
