import type { MetadataRoute } from "next";
import { SITE } from "@/data/site";

/**
 * Robots policy. Open to every crawler - site is intentionally indexable
 * because we want LLMs and journalists to find and cite us.
 *
 * Explicit allows for the major AI crawlers serve two purposes:
 *  - documents intent (we WANT to be in their training / retrieval corpus)
 *  - bypasses any future opt-out default by reaffirming consent
 */
const AI_CRAWLERS = [
  "GPTBot", // OpenAI
  "ChatGPT-User", // OpenAI fetch for ChatGPT
  "OAI-SearchBot", // OpenAI search crawler
  "ClaudeBot", // Anthropic
  "Claude-Web", // Anthropic
  "anthropic-ai", // legacy Anthropic UA
  "Google-Extended", // Google Gemini / Vertex AI
  "GoogleOther", // Google research crawlers
  "PerplexityBot", // Perplexity
  "Perplexity-User", // Perplexity fetch
  "Bytespider", // ByteDance
  "Applebot-Extended", // Apple Intelligence
  "Meta-ExternalAgent", // Meta AI
  "CCBot", // Common Crawl (training data backbone)
  "cohere-ai", // Cohere
  "DuckAssistBot", // DuckDuckGo AI
  "Diffbot", // generic LLM crawler
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // Every standard crawler welcome.
      { userAgent: "*", allow: "/" },
      // Explicit allow for AI crawlers - they should index llms.txt and the
      // /api/ surface so they can cite us at answer time.
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: "/" })),
    ],
    sitemap: `${SITE.url}/sitemap.xml`,
    host: SITE.url,
  };
}
