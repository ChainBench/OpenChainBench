import { describe, expect, test } from "bun:test";
import { shapeAgentTraffic } from "../lib/vercel-obs";

const day = (d: string) => `${d}T00:00:00.000Z`;

describe("agent traffic shaping", () => {
  test("publishes the AI total both with and without the largest bot", () => {
    // The reason this figure is published twice: on 2026-09-30 a single
    // crawler, meta-externalagent, was 73,192 of 75,429 AI requests, and it
    // was looping over fifteen static pages rather than indexing. One number
    // would have read as adoption.
    const t = shapeAgentTraffic({
      daily: [],
      bots: [
        { timestamp: day("2026-09-29"), vercel_request_count_sum: 73192, bot_name: "meta-externalagent", bot_category: "ai_crawler" },
        { timestamp: day("2026-09-29"), vercel_request_count_sum: 1432, bot_name: "oai-searchbot", bot_category: "ai_assistant" },
        { timestamp: day("2026-09-29"), vercel_request_count_sum: 210, bot_name: "claudebot", bot_category: "ai_crawler" },
        { timestamp: day("2026-09-29"), vercel_request_count_sum: 3335, bot_name: "googlebot", bot_category: "search_engine_crawler" },
      ],
      aiPaths: [],
      windowDays: 30,
      pathsWindowDays: 7,
    });
    expect(t.aiRequests).toBe(73192 + 1432 + 210);
    expect(t.topAiBot).toBe("meta-externalagent");
    expect(t.aiRequestsExcludingTop).toBe(1432 + 210);
    // Googlebot is not an AI bot and must not be in the AI total.
    expect(t.bots.find((b) => b.bot === "googlebot")?.category).toBe("search_engine_crawler");
  });

  test("a bot's daily rows are summed, and the share is of bot traffic only", () => {
    const t = shapeAgentTraffic({
      daily: [],
      bots: [
        { timestamp: day("2026-09-28"), vercel_request_count_sum: 100, bot_name: "claudebot", bot_category: "ai_crawler" },
        { timestamp: day("2026-09-29"), vercel_request_count_sum: 300, bot_name: "claudebot", bot_category: "ai_crawler" },
        { timestamp: day("2026-09-29"), vercel_request_count_sum: 100, bot_name: "googlebot", bot_category: "search_engine_crawler" },
        // The unclassified bucket comes back with an empty bot name; it is not a bot.
        { timestamp: day("2026-09-29"), vercel_request_count_sum: 9999, bot_name: "", bot_category: "" },
      ],
      aiPaths: [],
      windowDays: 30,
      pathsWindowDays: 7,
    });
    expect(t.bots.map((b) => b.bot)).toEqual(["claudebot", "googlebot"]);
    expect(t.bots[0].requests).toBe(400);
    expect(t.bots[0].sharePct).toBeCloseTo(80, 5);
  });

  test("an unknown category is carried through as itself, not folded into other", () => {
    // Vercel ships more categories than the two AI ones (browser_impersonation,
    // http_client, client_anomaly...). Folding them would hide a new one.
    const t = shapeAgentTraffic({
      daily: [
        { timestamp: day("2026-09-29"), vercel_request_count_sum: 500, bot_category: "browser_impersonation" },
        { timestamp: day("2026-09-29"), vercel_request_count_sum: 300, bot_category: "ai_crawler" },
        { timestamp: day("2026-09-29"), vercel_request_count_sum: 200, bot_category: "" },
      ],
      bots: [],
      aiPaths: [],
      windowDays: 30,
      pathsWindowDays: 7,
    });
    expect(t.categories.map((c) => c.category)).toContain("browser_impersonation");
    expect(t.totalRequests).toBe(1000);
    const d = t.daily[0];
    expect(d.ai).toBe(300);
    expect(d.other).toBe(500);
    expect(d.unclassified).toBe(200);
  });

  test("the first day with data skips the empty days before Observability was on", () => {
    // The window reaches back past the day the entitlement was enabled, and
    // those days come back as real zero rows rather than as absent rows.
    const t = shapeAgentTraffic({
      daily: [
        { timestamp: day("2026-09-20"), vercel_request_count_sum: 0, bot_category: "" },
        { timestamp: day("2026-09-21"), vercel_request_count_sum: 0, bot_category: "ai_crawler" },
        { timestamp: day("2026-09-28"), vercel_request_count_sum: 11672, bot_category: "" },
      ],
      bots: [],
      aiPaths: [],
      windowDays: 30,
      pathsWindowDays: 7,
    });
    expect(t.firstDayWithData).toBe("2026-09-28");
    expect(t.daily.map((d) => d.day)).toEqual(["2026-09-20", "2026-09-21", "2026-09-28"]);
  });

  test("paths are summed across daily buckets and zero rows dropped", () => {
    const t = shapeAgentTraffic({
      daily: [],
      bots: [],
      aiPaths: [
        { timestamp: day("2026-09-28"), vercel_request_count_sum: 1200, request_path: "/about" },
        { timestamp: day("2026-09-29"), vercel_request_count_sum: 2271, request_path: "/about" },
        { timestamp: day("2026-09-29"), vercel_request_count_sum: 3538, request_path: "/contribute" },
        { timestamp: day("2026-09-27"), vercel_request_count_sum: 0, request_path: "/never-read" },
      ],
      windowDays: 30,
      pathsWindowDays: 7,
    });
    expect(t.aiPaths).toEqual([
      { path: "/contribute", requests: 3538 },
      { path: "/about", requests: 3471 },
    ]);
    expect(t.aiPathsWindowDays).toBe(7);
  });
});
