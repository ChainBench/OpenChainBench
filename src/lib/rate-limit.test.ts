import { describe, expect, test } from "bun:test";
import { isAiCrawler, rateLimit } from "./rate-limit";

/** Build a minimal Request with a single User-Agent header. The lib only
 *  reads `user-agent`; method and URL are inert for these tests. */
function reqWithUa(ua: string | null): Request {
  const headers = new Headers();
  if (ua !== null) headers.set("user-agent", ua);
  return new Request("https://example.test/", { headers });
}

describe("isAiCrawler", () => {
  test("matches known crawler substrings case-insensitively", () => {
    expect(isAiCrawler("Mozilla/5.0 GPTBot/2.0")).toBe(true);
    expect(isAiCrawler("perplexitybot/1.0")).toBe(true);
    expect(isAiCrawler("Mozilla/5.0 ChatGPT-User/1.0")).toBe(true);
    expect(isAiCrawler("Mozilla/5.0 (Linux) claudebot/1.0")).toBe(true);
    expect(isAiCrawler("anthropic-ai")).toBe(true);
    expect(isAiCrawler("ccbot/2.0")).toBe(true);
  });

  test("returns false for plain browsers and empty UAs", () => {
    expect(isAiCrawler("Mozilla/5.0 (Macintosh) Chrome/121")).toBe(false);
    expect(isAiCrawler("")).toBe(false);
    expect(isAiCrawler(null)).toBe(false);
    expect(isAiCrawler(undefined)).toBe(false);
  });
});

describe("rateLimit AI crawler bypass", () => {
  test("known AI UA bypasses the bucket regardless of state", () => {
    // Pre-drain the bucket so a non-bypassed call would be denied.
    const key = "test-bypass:1.2.3.4";
    for (let i = 0; i < 5; i++) rateLimit(key, 5, 60);
    const drained = rateLimit(key, 5, 60);
    expect(drained.ok).toBe(false);

    const bypass = rateLimit(key, 5, 60, reqWithUa("Mozilla/5.0 GPTBot/2.0"));
    expect(bypass.ok).toBe(true);
    expect(bypass.retryAfterSec).toBe(0);
  });

  test("non-bot UA still consumes a token and can be throttled", () => {
    const key = "test-browser:5.6.7.8";
    let last = rateLimit(key, 2, 60, reqWithUa("Mozilla/5.0 Chrome/121"));
    expect(last.ok).toBe(true);
    last = rateLimit(key, 2, 60, reqWithUa("Mozilla/5.0 Chrome/121"));
    expect(last.ok).toBe(true);
    last = rateLimit(key, 2, 60, reqWithUa("Mozilla/5.0 Chrome/121"));
    expect(last.ok).toBe(false);
  });

  test("missing UA defaults to throttled (cautious default)", () => {
    const key = "test-noua:9.9.9.9";
    let last = rateLimit(key, 1, 60, reqWithUa(null));
    expect(last.ok).toBe(true);
    last = rateLimit(key, 1, 60, reqWithUa(null));
    expect(last.ok).toBe(false);
  });

  test("omitting req keeps original strict behaviour", () => {
    const key = "test-noreq:10.0.0.1";
    let last = rateLimit(key, 1, 60);
    expect(last.ok).toBe(true);
    last = rateLimit(key, 1, 60);
    expect(last.ok).toBe(false);
  });
});
