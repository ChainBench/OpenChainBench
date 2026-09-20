import { describe, expect, test } from "bun:test";
import { AI_DOMAINS, classifyPath, classifyReferrer, referrerPredicate } from "../lib/channels";

describe("classifyReferrer", () => {
  test("AI assistants", () => {
    for (const d of ["chatgpt.com", "www.perplexity.ai", "claude.ai", "gemini.google.com", "copilot.microsoft.com", "chat.mistral.ai"]) {
      expect(classifyReferrer(d)).toBe("ai");
    }
  });
  test("search engines, including country TLDs", () => {
    for (const d of ["www.google.com", "google.fr", "www.google.co.uk", "bing.com", "cn.bing.com", "duckduckgo.com", "search.brave.com", "yandex.ru"]) {
      expect(classifyReferrer(d)).toBe("search");
    }
  });
  test("gemini is AI even though it is a google host", () => {
    expect(classifyReferrer("gemini.google.com")).toBe("ai");
  });
  test("other google properties are referrals", () => {
    expect(classifyReferrer("docs.google.com")).toBe("referral");
    expect(classifyReferrer("mail.google.com")).toBe("referral");
  });
  test("social", () => {
    for (const d of ["t.co", "x.com", "www.linkedin.com", "old.reddit.com", "news.ycombinator.com", "t.me", "warpcast.com"]) {
      expect(classifyReferrer(d)).toBe("social");
    }
  });
  test("direct and internal", () => {
    expect(classifyReferrer("$direct")).toBe("direct");
    expect(classifyReferrer("")).toBe("direct");
    expect(classifyReferrer(null)).toBe("direct");
    expect(classifyReferrer("openchainbench.com")).toBe("internal");
    expect(classifyReferrer("staging.openchainbench.com")).toBe("internal");
  });
  test("suffix matching never crosses a label boundary", () => {
    expect(classifyReferrer("notchatgpt.com")).toBe("referral");
    expect(classifyReferrer("fakex.com")).toBe("referral");
  });
});

describe("referrerPredicate", () => {
  test("AI: exact list plus subdomains", () => {
    const sql = referrerPredicate("ai");
    expect(sql).toContain("'chatgpt.com'");
    expect(sql).toContain("endsWith(properties.$referring_domain, '.perplexity.ai')");
    expect(sql.split("'").length).toBeGreaterThan(AI_DOMAINS.length * 2);
  });
  test("search: Google and Bing country hosts, Gemini excluded", () => {
    const sql = referrerPredicate("search");
    expect(sql).toContain("google[.][a-z.]+$");
    expect(sql).toContain("bing[.]com$");
    expect(sql).toContain("NOT (properties.$referring_domain IN ('gemini.google.com'");
  });
});

describe("classifyPath", () => {
  test("rpc pages are the -rpc bench slugs and the hub is a hub", () => {
    expect(classifyPath("/benchmarks/arbitrum-rpc")).toBe("rpc");
    expect(classifyPath("/benchmarks/keyed-rpc-solana")).toBe("rpc");
    expect(classifyPath("/benchmarks/arbitrum-rpc/base")).toBe("rpc");
    expect(classifyPath("/rpc")).toBe("hubs");
  });
  test("other benches, compare, answers, products, chains", () => {
    expect(classifyPath("/benchmarks/bridge-fee")).toBe("benchmarks");
    expect(classifyPath("/benchmarks/bridge-fee/?chain=base")).toBe("benchmarks");
    expect(classifyPath("/benchmarks")).toBe("benchmarks");
    expect(classifyPath("/compare/lifi-vs-relay")).toBe("compare");
    expect(classifyPath("/answers/cheapest-bridge-usdc-to-base")).toBe("answers");
    expect(classifyPath("/products/relay")).toBe("products");
    expect(classifyPath("/alternatives/alchemy")).toBe("products");
    expect(classifyPath("/chains/base")).toBe("chains");
  });
  test("home, hubs, docs, api, other", () => {
    expect(classifyPath("/")).toBe("home");
    expect(classifyPath("")).toBe("home");
    expect(classifyPath(null)).toBe("home");
    expect(classifyPath("/bridge")).toBe("hubs");
    expect(classifyPath("/hyperliquid/metamask")).toBe("hubs");
    expect(classifyPath("/methodology")).toBe("docs");
    expect(classifyPath("/mcp")).toBe("docs");
    expect(classifyPath("/api/stat/bridge-fee")).toBe("api");
    expect(classifyPath("/llms.txt")).toBe("api");
    expect(classifyPath("/sitemap.xml")).toBe("api");
    expect(classifyPath("/something-else")).toBe("other");
  });
});
