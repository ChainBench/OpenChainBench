/**
 * The AI and answer-engine crawlers, in one place.
 *
 * Three files need this list and each does something different with it:
 *   - `src/app/robots.ts` decides whether we invite it,
 *   - `src/lib/rate-limit.ts` decides whether it gets 429s on the endpoints
 *     built to be cited,
 *   - `src/lib/analytics-server.ts` decides whether it shows in our own
 *     numbers or lands in "other".
 *
 * rate-limit.ts carried the instruction "Keep in sync with robots.txt" in a
 * comment and nothing enforced it, so the three drifted. Measured on
 * 2026-10-19 from Vercel Observability, production, the seven previous days:
 * ExaSearchBot is the single biggest crawler on the site at 13,142 requests,
 * ahead of Googlebot's 10,210, and it was named in none of the three. Nor was
 * Meta-WebIndexer, the agent Meta's own documentation describes as the one
 * that "navigates the web to improve Meta AI search result quality", at 4,632.
 * Meta had moved its crawl onto it: meta-externalagent, which made 73,192
 * requests in three days in September, is down to 103 a week.
 *
 * So the list lives here, the three consumers derive from it, and
 * `ai-crawlers.test.ts` fails if one of them stops agreeing.
 *
 * `reqs7d` is kept beside each entry on purpose. It is the difference between
 * a list of crawlers someone thought mattered and a list of crawlers that
 * demonstrably read this site, and it is what makes the question "should this
 * be here" answerable. 0 means we did not see it in that window and keep the
 * entry anyway, because an allow is a statement of intent that costs nothing.
 */

export type AiCrawlerSource =
  /** The operator documents this token. */
  | "docs"
  /** Seen in our own request logs as a raw User-Agent. */
  | "logs"
  /** Taken from Vercel's normalised `botName`; the raw User-Agent token is
   *  probably but not certainly this string. Harmless in robots.txt and in a
   *  substring match: a token that never appears simply never matches. */
  | "vercel-label";

export type AiCrawler = {
  /** Token matched case-insensitively in a User-Agent, and the name written
   *  into robots.txt. */
  ua: string;
  /** Who runs it and what it feeds. */
  operator: string;
  /** Grouping key for our own analytics. Several tokens may share one. */
  family: string;
  /** Requests over the seven days to 2026-10-19, production. */
  reqs7d: number;
  source: AiCrawlerSource;
};

export const AI_CRAWLERS: AiCrawler[] = [
  // Answer engines, biggest first. These are the ones whose absence costs us
  // citations rather than tidiness.
  { ua: "ExaSearchBot", operator: "Exa, retrieval API behind other assistants", family: "exa", reqs7d: 13142, source: "logs" },
  { ua: "OAI-SearchBot", operator: "OpenAI search index", family: "oai-searchbot", reqs7d: 6394, source: "docs" },
  { ua: "Meta-WebIndexer", operator: "Meta, feeds Meta AI search results", family: "meta-webindexer", reqs7d: 4632, source: "docs" },
  { ua: "Claude-User", operator: "Anthropic, fetch on a user's behalf", family: "claude-user", reqs7d: 4446, source: "docs" },
  { ua: "Amazonbot", operator: "Amazon, Alexa and Rufus answers", family: "amazonbot", reqs7d: 3207, source: "docs" },
  { ua: "PerplexityBot", operator: "Perplexity index", family: "perplexitybot", reqs7d: 1691, source: "docs" },
  { ua: "GoogleOther", operator: "Google research and product crawlers", family: "googleother", reqs7d: 1189, source: "docs" },
  { ua: "GPTBot", operator: "OpenAI model training", family: "gptbot", reqs7d: 942, source: "docs" },
  { ua: "gpt-actions", operator: "OpenAI, action and plugin fetches", family: "gpt-actions", reqs7d: 799, source: "vercel-label" },
  { ua: "ShapBot", operator: "Shap, answer engine", family: "shapbot", reqs7d: 696, source: "vercel-label" },
  { ua: "ChatGPT-User", operator: "OpenAI, fetch on a user's behalf", family: "chatgpt-user", reqs7d: 542, source: "docs" },
  { ua: "ClaudeBot", operator: "Anthropic model training", family: "claudebot", reqs7d: 510, source: "docs" },
  // Its own family, not "duckduckgo": DuckAssistBot answers questions and
  // DuckDuckBot indexes pages, and the generic table still maps
  // DuckDuckBot. Sharing one family made 284 AI fetches and 355 search
  // crawls indistinguishable in our own numbers.
  { ua: "DuckAssistBot", operator: "DuckDuckGo AI answers", family: "duckassistbot", reqs7d: 284, source: "docs" },
  { ua: "MistralAI-User", operator: "Mistral, fetch on a user's behalf", family: "mistral", reqs7d: 109, source: "docs" },
  { ua: "Meta-ExternalAgent", operator: "Meta model training", family: "meta", reqs7d: 103, source: "docs" },
  { ua: "ChatGPT-Operator", operator: "OpenAI, agent driving a browser", family: "chatgpt-operator", reqs7d: 8, source: "vercel-label" },
  { ua: "Brightbot", operator: "Bright Data, retrieval for assistants", family: "brightbot", reqs7d: 1, source: "vercel-label" },

  // Not seen in the last window, kept allowed. Each was allowed before this
  // file existed and removing an allow is a decision, not a cleanup.

  // Its own family too, for the reason above: a search index is not a fetch
  // on a user's behalf.
  { ua: "Claude-SearchBot", operator: "Anthropic search index", family: "claude-searchbot", reqs7d: 0, source: "docs" },
  { ua: "Claude-Web", operator: "Anthropic, legacy token", family: "claudebot", reqs7d: 0, source: "docs" },
  { ua: "anthropic-ai", operator: "Anthropic, legacy token", family: "claudebot", reqs7d: 0, source: "docs" },
  { ua: "Perplexity-User", operator: "Perplexity, fetch on a user's behalf", family: "perplexity-user", reqs7d: 0, source: "docs" },
  { ua: "Google-Extended", operator: "Google Gemini and Vertex AI", family: "google-extended", reqs7d: 0, source: "docs" },
  { ua: "Applebot-Extended", operator: "Apple Intelligence", family: "applebot-extended", reqs7d: 0, source: "docs" },
  { ua: "Bytespider", operator: "ByteDance", family: "bytespider", reqs7d: 0, source: "docs" },
  { ua: "CCBot", operator: "Common Crawl, the training-data backbone", family: "ccbot", reqs7d: 0, source: "docs" },
  { ua: "cohere-ai", operator: "Cohere", family: "cohere", reqs7d: 0, source: "docs" },
  { ua: "Diffbot", operator: "Diffbot, generic LLM crawler", family: "diffbot", reqs7d: 0, source: "docs" },
  { ua: "YouBot", operator: "You.com", family: "youbot", reqs7d: 0, source: "docs" },
  { ua: "AI2Bot", operator: "Allen Institute for AI", family: "ai2bot", reqs7d: 0, source: "docs" },
  { ua: "Ai2Bot-Dolma", operator: "Allen Institute, Dolma corpus", family: "ai2bot", reqs7d: 0, source: "docs" },
  { ua: "Kagibot", operator: "Kagi", family: "kagibot", reqs7d: 0, source: "docs" },
  { ua: "FacebookBot", operator: "Meta, legacy token", family: "meta", reqs7d: 0, source: "docs" },
  { ua: "TimpiBot", operator: "Timpi", family: "timpibot", reqs7d: 0, source: "docs" },
  { ua: "Webzio-Extended", operator: "Webz.io", family: "webzio", reqs7d: 0, source: "docs" },
];

/** Tokens, for robots.txt. */
export const AI_CRAWLER_UAS: string[] = AI_CRAWLERS.map((c) => c.ua);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One alternation over every token, longest first.
 *
 * Longest first matters: `Applebot-Extended` contains `Applebot` and
 * `Ai2Bot-Dolma` contains `AI2Bot`, so a shorter token placed earlier would
 * claim the request and the specific family would never be reported.
 */
const BY_LENGTH = [...AI_CRAWLERS].sort((a, b) => b.ua.length - a.ua.length);

export const AI_CRAWLER_RE = new RegExp(
  BY_LENGTH.map((c) => escapeRe(c.ua)).join("|"),
  "i",
);

/** Analytics families, longest token first, ready to prepend to the generic
 *  user-agent table. Every AI entry has to sit before the `Mozilla/` catch-all
 *  there, because most of these crawlers put `Mozilla/5.0` in their own
 *  user-agent and would otherwise be counted as browsers. */
export const AI_CRAWLER_FAMILIES: [RegExp, string][] = BY_LENGTH.map((c) => [
  new RegExp(escapeRe(c.ua), "i"),
  c.family,
]);
