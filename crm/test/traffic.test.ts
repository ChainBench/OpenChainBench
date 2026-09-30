import { describe, expect, test } from "bun:test";
import { channelTotals, engagedBySection, QUERIES, sectionTotals, setKiosks, sumWindow, TRAFFIC_SECTIONS } from "../lib/traffic";

describe("queries", () => {
  test("every query is scoped to the production host and to a named event", () => {
    for (const name of TRAFFIC_SECTIONS) {
      const q = QUERIES[name]();
      expect(q).toContain("properties.$host = 'openchainbench.com'");
      expect(
        /event (= '\$pageview'|= '\$pageleave'|= '\$web_vitals'|= '(outbound_click|search|copy|not_found|search_no_result)'|IN \('outbound_click', 'copy', 'search'\)|IN \('markdown_read', 'stat_read', 'citable_read'\)|IN \('\$pageview', 'markdown_read', 'stat_read', 'citable_read'\))/.test(q),
      ).toBe(true);
    }
  });
  // A screen left on one page is not a reader. Two of them sent 1,411 of
  // the site's 2,989 pageviews in the week of 2026-09-20, so every
  // pageview query holds them out; the count of visitors barely moves
  // (885 against 887) and the count of pageviews halves.
  test("every pageview query holds kiosks out once they are known", () => {
    setKiosks(["kiosk-a", "kiosk-b"]);
    try {
      for (const name of TRAFFIC_SECTIONS) {
        if (name === "kiosks") continue; // the section that finds them
        const q = QUERIES[name]();
        if (!q.includes("event = '$pageview'") && !q.includes("event = '$pageleave'")) continue;
        expect(q).toContain("distinct_id NOT IN ('kiosk-a', 'kiosk-b')");
      }
    } finally {
      setKiosks([]);
    }
  });

  // Nobody found yet, or the section failed: the queries count everyone,
  // which is what this file did before the rule existed.
  test("an unknown kiosk list changes no query", () => {
    setKiosks([]);
    expect(QUERIES.totals()).not.toContain("NOT IN (");
    expect(QUERIES.totals()).toContain("1 = 1");
  });

  test("a kiosk is one page and many views", () => {
    const q = QUERIES.kiosks();
    expect(q).toContain("uniq(properties.$pathname) = 1");
    expect(q).toMatch(/count\(\) >= \d+/);
    expect(q).toContain("INTERVAL 90 DAY");
  });

  test("the engaged visitor is the one who opened a second page", () => {
    const q = QUERIES.engagedVisitors();
    expect(q).toContain("uniqIf(properties.$pathname, timestamp >= now() - INTERVAL 7 DAY) AS pages");
    expect(q).toContain("countIf(pages >= 2)");
    expect(q).toContain("countIf(prev_pages >= 2)");
  });

  // The guard is against a loop spending the organisation's hour, not
  // against the list growing: PostHog allows 2,400 queries an hour across
  // every key, this app's own budget defaults to 300, and one refresh
  // spends the list once. The bound had been passed by two sections
  // before the kiosk rule added a third.
  test("the refresh spends a bounded number of queries", () => {
    expect(TRAFFIC_SECTIONS.length).toBeLessThanOrEqual(30);
  });
  test("the surfaces series counts the four read events per day over 90 days", () => {
    const q = QUERIES.surfaces();
    for (const e of ["$pageview", "markdown_read", "stat_read", "citable_read"]) expect(q).toContain(`countIf(event = '${e}')`);
    expect(q).toContain("INTERVAL 89 DAY");
    expect(QUERIES.audience()).toContain("countIf(toDate(first_seen) < toDate(last_seen)) AS returning_visitors");
    expect(QUERIES.audienceDaily()).toContain("uniqIf(distinct_id, first_day < day) AS returning_visitors");
    expect(QUERIES.bounceDaily()).toContain("countIf(n = 1) AS bounced");
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
    const daily = [1, 2, 3, 4].map((i) => ({ day: `2026-09-0${i}`, pageviews: i, visitors: i, sessions: i, ai: 0, search: 0 }));
    expect(sumWindow(daily, 2).pageviews).toBe(7);
    expect(sumWindow(daily, 2, 2).pageviews).toBe(3);
  });
});
