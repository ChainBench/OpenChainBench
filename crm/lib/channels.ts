/**
 * Referrer and path classification. Pure functions, unit tested.
 *
 * The AI assistant channel is the number this dashboard exists for: a visit
 * referred by ChatGPT, Perplexity, Claude or Gemini is a citation that
 * converted, the only direct measurement of the GEO work. The lists are
 * exported so the weekly HogQL series can embed the same domains and the two
 * surfaces cannot disagree.
 */

export type Channel = "ai" | "search" | "social" | "direct" | "referral" | "internal";

export const AI_DOMAINS = [
  "chatgpt.com",
  "chat.openai.com",
  "openai.com",
  "perplexity.ai",
  "www.perplexity.ai",
  "claude.ai",
  "gemini.google.com",
  "bard.google.com",
  "copilot.microsoft.com",
  "you.com",
  "phind.com",
  "poe.com",
  "kagi.com",
  "grok.com",
  "x.ai",
  "mistral.ai",
  "chat.mistral.ai",
  "meta.ai",
] as const;

export const SEARCH_DOMAINS = [
  "google.com",
  "www.google.com",
  "bing.com",
  "www.bing.com",
  "duckduckgo.com",
  "search.yahoo.com",
  "yandex.ru",
  "yandex.com",
  "baidu.com",
  "www.baidu.com",
  "ecosia.org",
  "www.ecosia.org",
  "search.brave.com",
  "startpage.com",
  "qwant.com",
  "www.qwant.com",
  "naver.com",
  "search.naver.com",
] as const;

export const SOCIAL_DOMAINS = [
  "x.com",
  "twitter.com",
  "t.co",
  "linkedin.com",
  "www.linkedin.com",
  "lnkd.in",
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "out.reddit.com",
  "news.ycombinator.com",
  "t.me",
  "telegram.org",
  "web.telegram.org",
  "warpcast.com",
  "farcaster.xyz",
  "facebook.com",
  "www.facebook.com",
  "l.facebook.com",
  "youtube.com",
  "www.youtube.com",
  "discord.com",
  "medium.com",
  "substack.com",
  "mirror.xyz",
  "paragraph.xyz",
] as const;

const siteHost = (process.env.SITE_HOST ?? "openchainbench.com").toLowerCase();

export function classifyReferrer(domain: string | null | undefined): Channel {
  const d = (domain ?? "").toLowerCase().trim();
  if (!d || d === "$direct" || d === "direct" || d === "(none)") return "direct";
  if (d === siteHost || d.endsWith(`.${siteHost}`)) return "internal";
  const matches = (list: readonly string[]) => list.some((x) => d === x || d.endsWith(`.${x}`));
  if (matches(AI_DOMAINS)) return "ai";
  // Google: the search engine on any country TLD is search; every other
  // property (docs, mail, translate, sites) is a referral.
  if (/^(www\.)?google\.[a-z.]+$/.test(d)) return "search";
  if (/(^|\.)google\.[a-z.]+$/.test(d)) return "referral";
  if (/^(www\.)?bing\.com$/.test(d) || d.endsWith(".bing.com")) return "search";
  if (matches(SEARCH_DOMAINS)) return "search";
  if (matches(SOCIAL_DOMAINS)) return "social";
  return "referral";
}

/** SQL fragment: `properties.$referring_domain IN ('a', 'b')` for the AI and search lists. */
export function domainInList(list: readonly string[]): string {
  return list.map((x) => `'${x.replace(/'/g, "")}'`).join(", ");
}

export type Section =
  | "home"
  | "benchmarks"
  | "rpc"
  | "compare"
  | "answers"
  | "products"
  | "chains"
  | "hubs"
  | "reports"
  | "docs"
  | "api"
  | "other";

export const SECTION_LABEL: Record<Section, string> = {
  home: "Home",
  benchmarks: "Bench pages",
  rpc: "RPC pages",
  compare: "Compare",
  answers: "Answers",
  products: "Products",
  chains: "Chains",
  hubs: "Hubs",
  reports: "Reports",
  docs: "Docs and about",
  api: "API and feeds",
  other: "Other",
};

const HUBS = new Set([
  "/rpc",
  "/bridge",
  "/perps",
  "/perp",
  "/hyperliquid",
  "/prediction-markets",
  "/wallets",
  "/aggregators",
  "/staking",
  "/stablecoins",
  "/l2",
  "/memecoins",
]);

export function classifyPath(pathname: string | null | undefined): Section {
  const raw = (pathname ?? "/").split("?")[0].split("#")[0];
  const p = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
  if (p === "/" || p === "") return "home";
  if (p.startsWith("/benchmarks/")) {
    const slug = p.split("/")[2] ?? "";
    return slug.endsWith("-rpc") || slug.startsWith("keyed-rpc-") ? "rpc" : "benchmarks";
  }
  if (p === "/benchmarks") return "benchmarks";
  if (p.startsWith("/compare")) return "compare";
  if (p.startsWith("/answers")) return "answers";
  if (p.startsWith("/products") || p.startsWith("/alternatives")) return "products";
  if (p.startsWith("/chains")) return "chains";
  if (HUBS.has(p) || p.startsWith("/hyperliquid/") || p.startsWith("/perp/")) return "hubs";
  if (p.startsWith("/reports")) return "reports";
  if (p.startsWith("/api") || p === "/llms.txt" || p === "/llms-full.txt" || p.endsWith(".xml") || p.endsWith(".json")) return "api";
  if (["/methodology", "/about", "/contribute", "/mcp", "/team", "/press", "/partners", "/docs"].some((x) => p === x || p.startsWith(`${x}/`))) return "docs";
  return "other";
}
