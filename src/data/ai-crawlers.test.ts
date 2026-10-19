import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AI_CRAWLERS,
  AI_CRAWLER_FAMILIES,
  AI_CRAWLER_RE,
  AI_CRAWLER_UAS,
} from "./ai-crawlers";
import { isAiCrawler } from "@/lib/rate-limit";
import { uaFamily } from "@/lib/analytics-server";

/**
 * The AI crawler list had three copies and no guard.
 *
 * `src/lib/rate-limit.ts` carried the instruction "Keep in sync with
 * robots.txt" in a comment, which is not a mechanism. Measured 2026-10-19 from
 * Vercel Observability, production, seven days: ExaSearchBot made 13,142
 * requests, more than Googlebot's 10,210, and appeared in none of the three
 * lists; Meta-WebIndexer, which Meta documents as the crawler feeding Meta AI
 * search results, made 4,632 and appeared in none either. Claude-User made
 * 4,446 and was in the analytics table but in neither the allow list nor the
 * rate-limit bypass.
 *
 * These tests are the mechanism. They do not check that the list is complete,
 * which no test can know; they check that the three consumers still say the
 * same thing and that the file keeps the evidence that justifies each entry.
 */
describe("one AI crawler list, three consumers", () => {
  test("every crawler bypasses the rate limit on the citable endpoints", () => {
    // The bypass exists because these crawlers route many independent human
    // questions through a small pool of egress IPs, so a burst from one IP is
    // not abuse. A crawler missing here gets 429s on the endpoints built to be
    // cited, which is the opposite of the intent.
    const missed = AI_CRAWLERS.filter(
      (c) => !isAiCrawler(`Mozilla/5.0 (compatible; ${c.ua}/1.0; +https://example.com/bot)`),
    );
    expect(missed.map((c) => c.ua)).toEqual([]);
  });

  test("every crawler is classified rather than counted as a browser", () => {
    // Nearly all of them put Mozilla/5.0 in their user-agent, so an entry that
    // falls through to the browser catch-all is silently counted as a human.
    const wrong = AI_CRAWLERS.filter((c) => {
      const fam = uaFamily(`Mozilla/5.0 (compatible; ${c.ua}/1.0)`);
      return fam === "browser" || fam === "other";
    });
    expect(wrong.map((c) => `${c.ua} -> ${uaFamily(`Mozilla/5.0 (compatible; ${c.ua}/1.0)`)}`)).toEqual([]);
  });

  test("robots.ts derives its allow list instead of repeating it", () => {
    const src = readFileSync(join(import.meta.dir, "..", "app", "robots.ts"), "utf8");
    expect(src).toContain('from "@/data/ai-crawlers"');
    expect(src).toContain("AI_CRAWLER_UAS.map");
    // A second literal list in that file is the drift coming back.
    expect(src).not.toContain("const AI_CRAWLERS = [");
  });

  test("rate-limit.ts and analytics-server.ts derive theirs too", () => {
    const rl = readFileSync(join(import.meta.dir, "..", "lib", "rate-limit.ts"), "utf8");
    expect(rl).toContain('import { AI_CRAWLER_RE } from "@/data/ai-crawlers"');
    expect(rl).not.toMatch(/const AI_CRAWLER_RE\s*=\s*\n?\s*\//);
    const an = readFileSync(join(import.meta.dir, "..", "lib", "analytics-server.ts"), "utf8");
    expect(an).toContain("...AI_CRAWLER_FAMILIES,");
  });

  test("the specific token wins over the one it contains", () => {
    // Applebot-Extended contains Applebot and Ai2Bot-Dolma contains AI2Bot.
    // Ordering by token length is what keeps the specific family reported, and
    // getting it wrong would be invisible in the volumes.
    expect(uaFamily("Mozilla/5.0 (compatible; Applebot-Extended/1.0)")).toBe(
      "applebot-extended",
    );
    expect(uaFamily("Mozilla/5.0 (compatible; Ai2Bot-Dolma/1.0)")).toBe("ai2bot");
    const lengths = AI_CRAWLER_FAMILIES.map(([re]) => re.source.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  test("a browser and a plain client are still not crawlers", () => {
    expect(isAiCrawler("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")).toBe(false);
    expect(isAiCrawler("curl/8.4.0")).toBe(false);
    expect(isAiCrawler(null)).toBe(false);
    expect(uaFamily("curl/8.4.0")).toBe("curl");
    // Googlebot is a search crawler, not an answer engine: it belongs in the
    // generic half of the table and must not be claimed by the AI list.
    expect(isAiCrawler("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(false);
    expect(uaFamily("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe("googlebot");
  });

  test("the four commercial SEO crawlers are named but not allowlisted", () => {
    // Ahrefs and Semrush crawl us hard (3,071 and 840 requests over the same
    // week) and we do not want them in an allow list. Naming them in the
    // analytics table only stops them inflating "other".
    for (const ua of ["AhrefsBot/7.0", "SemrushBot/7~bl", "Barkrowler/0.9"]) {
      expect(isAiCrawler(`Mozilla/5.0 (compatible; ${ua})`)).toBe(false);
      expect(uaFamily(`Mozilla/5.0 (compatible; ${ua})`)).not.toBe("other");
    }
  });

  test("each entry carries the evidence that justifies it", () => {
    for (const c of AI_CRAWLERS) {
      expect(c.ua.length).toBeGreaterThan(2);
      expect(c.operator.length).toBeGreaterThan(3);
      expect(c.family).toMatch(/^[a-z0-9-]+$/);
      expect(c.reqs7d).toBeGreaterThanOrEqual(0);
      expect(["docs", "logs", "vercel-label"]).toContain(c.source);
    }
    // No duplicate token, which would double every allow line in robots.txt.
    expect(new Set(AI_CRAWLER_UAS).size).toBe(AI_CRAWLER_UAS.length);
    // The regex is one alternation, not a list someone forgot to join.
    expect(AI_CRAWLER_RE.flags).toContain("i");
    expect(AI_CRAWLER_RE.source.split("|").length).toBe(AI_CRAWLERS.length);
  });

  test("the crawlers that read us most are in the list", () => {
    // Not a completeness claim: these are the five biggest answer-engine
    // crawlers in the measured window, and the point of the file is that they
    // cannot fall out of it again without a test going red.
    for (const ua of [
      "ExaSearchBot",
      "OAI-SearchBot",
      "Meta-WebIndexer",
      "Claude-User",
      "PerplexityBot",
    ]) {
      const entry = AI_CRAWLERS.find((c) => c.ua === ua);
      expect(entry, `${ua} is missing from AI_CRAWLERS`).toBeDefined();
      expect(entry!.reqs7d).toBeGreaterThan(0);
    }
  });
});
