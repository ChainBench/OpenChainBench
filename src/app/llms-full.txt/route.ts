import { GET as buildLlmContext } from "@/app/api/llm-context/route";

export const runtime = "nodejs";
export const revalidate = 60;

/**
 * llms-full.txt — expanded sibling of /llms.txt per the llmstxt.org
 * convention. Serves the same body as /api/llm-context, but directly
 * (200 + text/markdown) instead of via redirect. The previous 307 broke
 * llms.txt validators and the stricter AI crawlers that do not follow
 * redirects on non-standard paths (Perplexity, some Bing AI scrapers),
 * which were marking the URL as no-content and skipping the resource.
 *
 * The canonical for AI citation is now /llms-full.txt itself, not the
 * internal /api/llm-context path.
 */
export const GET = buildLlmContext;
