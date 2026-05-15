import { redirect } from "next/navigation";

export const runtime = "nodejs";

/**
 * llms-full.txt — the expanded sibling of `/llms.txt` per the emerging
 * llmstxt.org convention. We serve the same content as `/api/llm-context`
 * (full rankings + methodology for every live benchmark) so an LLM that
 * follows the convention finds the rich Markdown view without having to
 * know our internal API path.
 *
 * Internal redirect keeps a single source of truth; the `/llms-full.txt`
 * URL is what crawlers will look up.
 */
export function GET() {
  redirect("/api/llm-context");
}
