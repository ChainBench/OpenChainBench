import { describe, expect, setSystemTime, test } from "bun:test";
import {
  clientNetworkKey,
  clientSubnetKey,
  globalLimit,
  isAiCrawler,
  peekLimit,
  rateLimit,
} from "./rate-limit";

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

const LONG_AGO = new Date("2000-01-01T00:00:00Z");

test("a flood of new callers does not reset a site-wide cap", () => {
  const callers = 6_000;
  setSystemTime(LONG_AGO);
  try {
    expect(globalLimit("flood", 1, 60).ok).toBe(true);
    for (let i = 0; i < callers; i += 1) rateLimit(`flood:${i}`, 1, 60);
    expect(globalLimit("flood", 1, 60).ok).toBe(false);
  } finally {
    setSystemTime();
  }
});

test("a flood of new callers does not reset a used-up network cap", () => {
  setSystemTime(LONG_AGO);
  try {
    for (let i = 0; i < 3; i += 1) rateLimit("used-up", 3, 60);
    for (let i = 0; i < 6_000; i += 1) rateLimit(`caller:${i}`, 30, 60);
    expect(rateLimit("used-up", 3, 60).ok).toBe(false);
  } finally {
    setSystemTime();
  }
});

test("a full table drops the bucket that refills soonest", () => {
  setSystemTime(LONG_AGO);
  try {
    expect(rateLimit("short-window", 1, 1).ok).toBe(true);
    for (let i = 0; i < 6_000; i += 1) rateLimit(`newcomer:${i}`, 30, 60);
    expect(rateLimit("short-window", 1, 1).ok).toBe(true);
  } finally {
    setSystemTime();
  }
});

test("peeking a bucket without capacity refuses with a finite wait", () => {
  const peeked = peekLimit("no-capacity", 0, 60);
  expect(peeked.ok).toBe(false);
  expect(Number.isFinite(peeked.retryAfterSec)).toBe(true);
});

test("peeking a bucket spends nothing", () => {
  for (let i = 0; i < 5; i += 1) {
    expect(peekLimit("peeked", 1, 60).ok).toBe(true);
  }
  expect(rateLimit("peeked", 1, 60).ok).toBe(true);
  expect(peekLimit("peeked", 1, 60).ok).toBe(false);
});

test("IPv4 addresses in one /24 share a subnet key", () => {
  const from = (ip: string) =>
    clientSubnetKey(
      new Request("http://localhost/", {
        headers: { "x-vercel-forwarded-for": ip },
      }),
      "route",
    );
  expect(from("203.0.113.7")).toBe(from("203.0.113.200"));
  expect(from("203.0.113.7")).not.toBe(from("203.0.114.7"));
  expect(from("2001:db8:1::1")).toBe(from("2001:db8:1:ffff::2"));
  expect(from("::ffff:203.0.113.7")).toBe(from("203.0.113.200"));
  expect(from("::ffff:cb00:7107")).toBe(from("203.0.113.200"));
  expect(from("::ffff:cb00:7107")).not.toBe(from("::ffff:cb00:7207"));
});

describe("clientNetworkKey", () => {
  const from = (ip: string) =>
    clientNetworkKey(
      new Request("http://localhost/", {
        headers: { "x-vercel-forwarded-for": ip },
      }),
      "route",
    );

  test("IPv6 addresses in one /64 share a key", () => {
    expect(from("2001:db8:1:2:aaaa::1")).toBe(
      from("2001:0DB8:0001:0002:bbbb:0:0:2"),
    );
    expect(from("2001:db8::7")).toBe(from("2001:db8:0:0:ffff::8"));
    expect(from("2001:db8:1:2::1")).not.toBe(from("2001:db8:1:3::1"));
  });

  test("IPv4 addresses keep their own key", () => {
    expect(from("203.0.113.7")).not.toBe(from("203.0.113.8"));
    expect(from("::ffff:203.0.113.7")).not.toBe(from("::ffff:203.0.113.8"));
    expect(from("::ffff:cb00:7107")).toBe(from("203.0.113.7"));
    expect(from("::ffff:cb00:7107")).not.toBe(from("::ffff:cb00:7108"));
  });
});
