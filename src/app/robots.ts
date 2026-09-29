import type { MetadataRoute } from "next";
import { headers } from "next/headers";
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

const canonicalHost = new URL(SITE.url).hostname.toLowerCase();

export default async function robots(): Promise<MetadataRoute.Robots> {
  // Staging / preview deploys (Vercel `dev` branch, per-PR previews) must
  // not be indexed. Otherwise Google sees two copies of the site — the
  // openchainbench.com production and the *.vercel.app staging — and flags
  // duplicate content, costing the prod domain its SERP authority. Only
  // VERCEL_ENV='production' (the alias openchainbench.com) gets the open
  // crawl policy; everything else returns Disallow: /.
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
    return {
      rules: [{ userAgent: "*", disallow: "/" }],
    };
  }

  // VERCEL_ENV alone is not enough. It describes the build, not the
  // hostname serving it, so a production build aliased to another domain
  // reports "production" and returns the open policy below. That happened:
  // on 2026-09-29 staging.openchainbench.com pointed at a production
  // deployment and served `Allow: /` with no noindex, making the whole
  // catalog crawlable on two hostnames. Reading the request host closes it.
  // next.config.ts carries the same rule as an X-Robots-Tag header, which
  // covers every page rather than only this file.
  const host = (await headers()).get("host")?.split(":")[0]?.toLowerCase();
  if (host && host !== canonicalHost) {
    return {
      rules: [{ userAgent: "*", disallow: "/" }],
    };
  }

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
