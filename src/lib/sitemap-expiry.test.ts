import { describe, expect, test } from "bun:test";
import { isExpiredBench, isExpiredPage, NOINDEX_AFTER_HOURS } from "@/lib/provider-filters";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const EPOCH = new Date(0).toISOString();

/**
 * isExpiredBench guards the sitemap against listing a page that renders
 * noindex. It was inert on the only surface that calls it: the worker
 * publishes sitemap rows with slug, lastRunAt, category and perChainSlugs
 * and no status, so `b.status === "live"` was false for every row and the
 * guard never fired.
 *
 * Found 2026-10-02 when bridge-execution-latency and bridge-realized-cost
 * blocked a production deploy. Their harness has recorded no run, so
 * lastRunAt is the Unix epoch and the page renders noindex, and both were
 * still listed. The RPC variant has no status check, which is why chain
 * pages expired correctly and nothing else did.
 */
describe("isExpiredBench", () => {
  test("fires on a row with no status, which is every sitemap row", () => {
    expect(isExpiredBench({ lastRunAt: EPOCH })).toBe(true);
    expect(isExpiredBench({ lastRunAt: hoursAgo(NOINDEX_AFTER_HOURS + 1) })).toBe(true);
  });

  test("fires when the status is explicitly null, as the worker now publishes it", () => {
    expect(isExpiredBench({ lastRunAt: EPOCH, status: null })).toBe(true);
  });

  test("still fires on an explicit live status", () => {
    expect(isExpiredBench({ lastRunAt: EPOCH, status: "live" })).toBe(true);
  });

  test("leaves fresh data alone whatever the status", () => {
    expect(isExpiredBench({ lastRunAt: hoursAgo(1) })).toBe(false);
    expect(isExpiredBench({ lastRunAt: hoursAgo(1), status: null })).toBe(false);
    expect(isExpiredBench({ lastRunAt: hoursAgo(NOINDEX_AFTER_HOURS - 1) })).toBe(false);
  });

  test("a draft bench is not expired by this rule", () => {
    expect(isExpiredBench({ lastRunAt: EPOCH, status: "draft" })).toBe(false);
  });

  // The epoch is deliberate: materialize/load.ts writes it when a bench
  // declares a freshness_timestamp_metric and Prometheus reports no run,
  // "so say so rather than pretending". A 56-year-old page must not be
  // advertised to crawlers.
  test("the epoch, which means no run was ever recorded, is expired", () => {
    expect(isExpiredPage({ slug: "bridge-execution-latency", lastRunAt: EPOCH })).toBe(true);
    expect(isExpiredPage({ slug: "bridge-realized-cost", lastRunAt: EPOCH })).toBe(true);
  });

  test("an unparsable or missing timestamp is expired, not ignored", () => {
    expect(isExpiredBench({ lastRunAt: null })).toBe(true);
    expect(isExpiredBench({ lastRunAt: "not a date" })).toBe(true);
    expect(isExpiredBench({})).toBe(true);
  });
});
