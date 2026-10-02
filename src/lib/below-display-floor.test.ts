import { describe, expect, test } from "bun:test";
import { belowDisplayFloor, displayResults, MIN_DISPLAY_SUCCESS_PCT } from "@/lib/provider-filters";
import type { ProviderResult } from "@/types/benchmark";

const r = (slug: string, successRate: number, p50 = 100): ProviderResult =>
  ({
    slug,
    name: slug,
    ms: { p50, p90: p50, p99: p50, mean: p50 },
    successRate,
    sampleSize: 4000,
  }) as unknown as ProviderResult;

describe("belowDisplayFloor", () => {
  // The two selectors must partition the live set. If a provider could fall
  // into neither, it would be invisible again, which is the whole defect.
  test("it is exactly the complement of displayResults over live rows", () => {
    const rows = [r("a", 100), r("b", 60), r("c", 4.9), r("d", 0.3), r("e", 5)];
    const shown = displayResults(rows).map((x) => x.slug);
    const hidden = belowDisplayFloor(rows).map((x) => x.slug);
    expect(shown.sort()).toEqual(["a", "b", "e"]);
    expect(hidden.sort()).toEqual(["c", "d"]);
    expect([...shown, ...hidden].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("the floor itself counts as shown, not hidden", () => {
    expect(displayResults([r("x", MIN_DISPLAY_SUCCESS_PCT)])).toHaveLength(1);
    expect(belowDisplayFloor([r("x", MIN_DISPLAY_SUCCESS_PCT)])).toHaveLength(0);
  });

  test("worst last: the order is by success, best first", () => {
    const rows = [r("worst", 0.2), r("best", 4.8), r("mid", 2)];
    expect(belowDisplayFloor(rows).map((x) => x.slug)).toEqual(["best", "mid", "worst"]);
  });

  // The real case: Thirdweb answered 0.3 % to 1.5 % across 29 chains while
  // serving a consumer connection fine. Nothing should drop it on the floor
  // of having "no data": it has data, and the data is the finding.
  test("a provider that answers rarely is kept, not treated as absent", () => {
    const rows = [r("official", 100), r("thirdweb", 0.8)];
    const hidden = belowDisplayFloor(rows);
    expect(hidden).toHaveLength(1);
    expect(hidden[0].slug).toBe("thirdweb");
    expect(hidden[0].successRate).toBe(0.8);
  });

  test("an empty or all-healthy set yields nothing", () => {
    expect(belowDisplayFloor([])).toEqual([]);
    expect(belowDisplayFloor([r("a", 100), r("b", 99)])).toEqual([]);
  });
});
