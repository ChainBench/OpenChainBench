import { describe, expect, test } from "bun:test";
import { channelTotals, engagedBySection, QUERIES, sectionTotals, sumWindow, TRAFFIC_SECTIONS } from "../lib/traffic";

describe("queries", () => {
  test("every query is scoped to the production host and to a named event", () => {
    for (const name of TRAFFIC_SECTIONS) {
      const q = QUERIES[name]();
      expect(q).toContain("properties.$host = 'openchainbench.com'");
      expect(/event (= '\$pageview'|= '\$pageleave'|= '\$web_vitals'|= '(outbound_click|search|copy|not_found|search_no_result)'|IN \('outbound_click', 'copy', 'search'\))/.test(q)).toBe(true);
    }
  });
  test("the refresh spends a bounded number of queries", () => {
    expect(TRAFFIC_SECTIONS.length).toBeLessThanOrEqual(24);
  });
  test("the weekly series and the totals embed the AI domain list", () => {
    expect(QUERIES.weekly()).toContain("'chatgpt.com'");
    expect(QUERIES.weekly()).toContain("'perplexity.ai'");
    expect(QUERIES.totals()).toContain("'chatgpt.com'");
    expect(QUERIES.totals()).toContain("google[.][a-z.]+$");
  });
  test("page and referrer rows are ranked on either week, so losses survive the LIMIT", () => {
    expect(QUERIES.pages()).toContain("ORDER BY greatest(visitors, prev_visitors) DESC");
    expect(QUERIES.referrers()).toContain("ORDER BY greatest(visitors, prev_visitors) DESC");
  });
});

describe("aggregations", () => {
  const pages = [
    { path: "/benchmarks/arbitrum-rpc", section: "rpc" as const, visitors: 10, prevVisitors: 5, pageviews: 12 },
    { path: "/benchmarks/base-rpc", section: "rpc" as const, visitors: 0, prevVisitors: 2, pageviews: 0 },
    { path: "/compare/a-vs-b", section: "compare" as const, visitors: 4, prevVisitors: 4, pageviews: 4 },
  ];
  test("sectionTotals sums and counts pages with a visit", () => {
    const t = sectionTotals(pages);
    expect(t[0]).toEqual({ section: "rpc", visitors: 10, prevVisitors: 7, pageviews: 12, pages: 1 });
    expect(t[1].section).toBe("compare");
  });
  test("channelTotals", () => {
    const c = channelTotals([
      { domain: "chatgpt.com", channel: "ai", visitors: 3, prevVisitors: 1, pageviews: 3 },
      { domain: "perplexity.ai", channel: "ai", visitors: 2, prevVisitors: 0, pageviews: 2 },
      { domain: "$direct", channel: "direct", visitors: 20, prevVisitors: 25, pageviews: 30 },
    ]);
    expect(c[0]).toEqual({ channel: "direct", visitors: 20, prevVisitors: 25, domains: 1 });
    expect(c[1]).toEqual({ channel: "ai", visitors: 5, prevVisitors: 1, domains: 2 });
  });
  test("engagedBySection weights page medians by leaves", () => {
    const rows = engagedBySection([
      { section: "rpc", leaves: 10, medianSec: 20, p75Sec: 60 },
      { section: "rpc", leaves: 90, medianSec: 5, p75Sec: 15 },
      { section: "compare", leaves: 1, medianSec: 100, p75Sec: 200 },
    ]);
    expect(rows[0]).toEqual({ section: "rpc", leaves: 100, medianSec: 5, p75Sec: 15 });
    expect(rows[1].section).toBe("compare");
  });
  test("sumWindow takes the last N days, with an offset", () => {
    const daily = [1, 2, 3, 4].map((i) => ({ day: `2026-09-0${i}`, pageviews: i, visitors: i, sessions: i }));
    expect(sumWindow(daily, 2).pageviews).toBe(7);
    expect(sumWindow(daily, 2, 2).pageviews).toBe(3);
  });
});
