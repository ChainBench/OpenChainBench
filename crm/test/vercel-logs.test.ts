import { describe, expect, test } from "bun:test";
import { apiFamily, classifyUserAgent, emptyDay, foldEntry, mergeDay, parseBody } from "../lib/vercel-logs";

describe("classifyUserAgent", () => {
  test("AI, search, other, human", () => {
    expect(classifyUserAgent("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)")).toEqual({ kind: "ai_bot", name: "GPTBot" });
    expect(classifyUserAgent("Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)").name).toBe("ClaudeBot");
    expect(classifyUserAgent("Mozilla/5.0 (compatible; PerplexityBot/1.0)").kind).toBe("ai_bot");
    expect(classifyUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toEqual({ kind: "search_bot", name: "Googlebot" });
    expect(classifyUserAgent("Mozilla/5.0 (compatible; Google-Extended)").kind).toBe("ai_bot");
    expect(classifyUserAgent("curl/8.4.0").kind).toBe("other_bot");
    expect(classifyUserAgent("python-requests/2.31").kind).toBe("other_bot");
    expect(classifyUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15").kind).toBe("human");
    expect(classifyUserAgent("").kind).toBe("other_bot");
  });
});

describe("apiFamily", () => {
  test("machine paths", () => {
    expect(apiFamily("/api/stat/bridge-fee")).toBe("/api/stat");
    expect(apiFamily("/llms-full.txt")).toBe("/llms.txt");
    expect(apiFamily("/sitemap.xml")).toBe("/sitemap+robots");
    expect(apiFamily("/benchmarks/bridge-fee")).toBeNull();
  });
});

describe("foldEntry and mergeDay", () => {
  const entry = (path: string, ua: string, status = 200, host = "openchainbench.com") => ({
    proxy: { path, userAgent: [ua], statusCode: status, host, vercelCache: "HIT", timestamp: 1_758_000_000_000 },
  });
  test("counts classes, sections, api families, 404s; skips assets and other hosts", () => {
    const d = emptyDay("2026-09-20");
    expect(foldEntry(d, entry("/benchmarks/arbitrum-rpc", "GPTBot/1.2"))).toBe(true);
    expect(foldEntry(d, entry("/api/stat/bridge-fee", "ClaudeBot/1.0"))).toBe(true);
    expect(foldEntry(d, entry("/missing", "Mozilla/5.0 Safari/605.1.15", 404))).toBe(true);
    expect(foldEntry(d, entry("/_next/static/x.js", "GPTBot"))).toBe(false);
    expect(foldEntry(d, entry("/", "GPTBot", 200, "staging-openchainbench.vercel.app"))).toBe(false);
    expect(foldEntry(d, { message: "no proxy" } as never)).toBe(false);
    expect(d.requests).toBe(3);
    expect(d.byClass).toEqual({ ai_bot: 2, human: 1 });
    expect(d.aiBots).toEqual({ GPTBot: 1, ClaudeBot: 1 });
    expect(d.aiBySection).toEqual({ rpc: 1 });
    expect(d.api["/api/stat"]).toEqual({ ai_bot: 1 });
    expect(d.notFound).toEqual({ "/missing": 1 });
    expect(d.status).toEqual({ "200": 2, "404": 1 });
    expect(d.cache).toEqual({ HIT: 3 });
  });
  test("mergeDay adds every map", () => {
    const a = emptyDay("2026-09-20");
    const b = emptyDay("2026-09-20");
    foldEntry(a, entry("/x", "GPTBot"));
    foldEntry(b, entry("/y", "GPTBot"));
    foldEntry(b, entry("/api/citable", "curl/8"));
    const m = mergeDay(a, b);
    expect(m.requests).toBe(3);
    expect(m.aiBots).toEqual({ GPTBot: 2 });
    expect(m.api["/api/citable"]).toEqual({ other_bot: 1 });
  });
});

describe("parseBody", () => {
  test("array and ndjson", () => {
    expect(parseBody('[{"id":"1"},{"id":"2"}]').length).toBe(2);
    expect(parseBody('{"id":"1"}\n{"id":"2"}\nnot json\n').length).toBe(2);
    expect(parseBody("")).toEqual([]);
  });
});
