import { describe, expect, test } from "bun:test";
import { computeFieldStats } from "./stats";
import type { ProviderResult } from "@/types/benchmark";

function row(slug: string, p50: number, availability: ProviderResult["availability"] = "live"): ProviderResult {
  return {
    slug,
    name: slug,
    ms: { p50, p90: p50, p99: p50, mean: p50 },
    successRate: 100,
    availability,
  } as ProviderResult;
}

describe("computeFieldStats", () => {
  test("ignores unavailable rows", () => {
    const s = computeFieldStats([row("a", 5), row("b", 9), row("dead", 0, "unavailable")]);
    expect(s.fieldMin).toBe(5);
    expect(s.fieldMax).toBe(9);
  });

  test("ignores live rows with no headline value (all-zero), like the ledger", () => {
    // A token-less venue on a valuation bench: promoted to live by its
    // panel data, but no P/F to rank. Best must not read 0.
    const s = computeFieldStats([row("gains", 1.6), row("gmx", 3.4), row("ostium", 0)]);
    expect(s.fieldMin).toBe(1.6);
    expect(s.fieldMedian).toBe(3.4);
    expect(s.fieldMax).toBe(3.4);
  });

  test("keeps negative rows on signed benches", () => {
    const s = computeFieldStats([row("okx", -3), row("bybit", 2)]);
    expect(s.fieldMin).toBe(-3);
    expect(s.fieldMax).toBe(2);
  });

  test("empty field yields zeros", () => {
    const s = computeFieldStats([row("x", 0)]);
    expect(s).toEqual({ fieldMin: 0, fieldMedian: 0, fieldMax: 0, tailMin: 0, tailMax: 0, tailSpread: 0 });
  });
});
