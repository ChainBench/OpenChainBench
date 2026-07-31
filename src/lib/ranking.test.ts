import { describe, expect, test } from "bun:test";
import { rankResults, leader } from "./ranking";
import type { Benchmark, ProviderResult } from "@/types/benchmark";

function r(slug: string, p50: number, p99 = p50): ProviderResult {
  return {
    slug,
    name: slug,
    ms: { p50, p90: (p50 + p99) / 2, p99, mean: p50 },
    successRate: 100,
    availability: "live",
  };
}

function bench(results: ProviderResult[], higherIsBetter = false): Benchmark {
  return {
    slug: "test",
    number: "001",
    title: "Test",
    subtitle: "",
    lastRunAt: "",
    status: "live",
    editorialStatus: "live",
    sampleSize: 0,
    abstract: "",
    metric: "Latency",
    unit: "ms",
    higherIsBetter,
    category: "RPCs",
    results,
    findings: [],
    methodology: [],
    source: "",
    extras: { series24h: {}, regions: {} },
  };
}

describe("rankResults", () => {
  test("lower-is-better sorts ascending by p50 (best first)", () => {
    const input = [r("c", 300), r("a", 100), r("b", 200)];
    const out = rankResults(input, false);
    expect(out.map((x) => x.slug)).toEqual(["a", "b", "c"]);
  });

  test("higher-is-better sorts descending by p50 (best first)", () => {
    const input = [r("c", 300), r("a", 100), r("b", 200)];
    const out = rankResults(input, true);
    expect(out.map((x) => x.slug)).toEqual(["c", "b", "a"]);
  });

  test("does not mutate the original array", () => {
    const input = [r("b", 200), r("a", 100)];
    const copy = [...input];
    rankResults(input, false);
    expect(input).toEqual(copy);
  });

  test("returns empty array for empty input", () => {
    expect(rankResults([], false)).toEqual([]);
    expect(rankResults([], true)).toEqual([]);
  });

  test("single provider returns same array contents", () => {
    const input = [r("solo", 50)];
    expect(rankResults(input, false)).toEqual(input);
  });

  test("tie on p50 preserves original relative order (stable sort)", () => {
    const input = [r("a", 100), r("b", 100), r("c", 100)];
    const out = rankResults(input, false);
    expect(out.map((x) => x.slug)).toEqual(["a", "b", "c"]);
  });

  test("works with zero p50", () => {
    const input = [r("a", 0), r("b", 50)];
    expect(rankResults(input, false)[0].slug).toBe("a");
  });

  test("works with very large p50 values", () => {
    const input = [r("slow", 999_999), r("fast", 1)];
    expect(rankResults(input, false)[0].slug).toBe("fast");
    expect(rankResults(input, true)[0].slug).toBe("slow");
  });
});

describe("leader", () => {
  test("returns the provider with the lowest p50 for lower-is-better", () => {
    const b = bench([r("slow", 300), r("fast", 50), r("mid", 150)]);
    expect(leader(b)?.slug).toBe("fast");
  });

  test("returns the provider with the highest p50 for higher-is-better", () => {
    const b = bench([r("low", 10), r("high", 500), r("mid", 250)], true);
    expect(leader(b)?.slug).toBe("high");
  });

  test("returns undefined for bench with no results", () => {
    const b = bench([]);
    expect(leader(b)).toBeUndefined();
  });

  test("returns the only provider when there is one", () => {
    const b = bench([r("solo", 99)]);
    expect(leader(b)?.slug).toBe("solo");
  });

  test("leader slug matches first entry of rankResults output", () => {
    const results = [r("c", 300), r("a", 100), r("b", 200)];
    const b = bench(results);
    const top = leader(b);
    const ranked = rankResults(results, false);
    expect(top?.slug).toBe(ranked[0].slug);
  });
});
