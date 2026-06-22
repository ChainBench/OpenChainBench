import { describe, expect, test } from "bun:test";
import {
  aggregateConfidence,
  classifyHealth,
  formatHealthPct,
  HEALTHY_THRESHOLD,
  LOW_THRESHOLD,
} from "./sample-health";
import type { ProviderResult } from "@/types/benchmark";

function row(
  slug: string,
  sampleSize: number | undefined,
  availability: ProviderResult["availability"] = "live",
): ProviderResult {
  return {
    name: slug,
    slug,
    ms: { p50: 1, p90: 1, p99: 1, mean: 1 },
    successRate: 100,
    sampleSize,
    availability,
  };
}

describe("classifyHealth", () => {
  test("returns undefined when expectedN is missing", () => {
    expect(classifyHealth(100, undefined)).toBeUndefined();
    expect(classifyHealth(100, 0)).toBeUndefined();
  });

  test("returns undefined when sampleSize is missing", () => {
    expect(classifyHealth(undefined, 1000)).toBeUndefined();
    expect(classifyHealth(NaN, 1000)).toBeUndefined();
  });

  test("classifies healthy at and above 0.5", () => {
    expect(classifyHealth(500, 1000)?.confidence).toBe("healthy");
    expect(classifyHealth(1000, 1000)?.confidence).toBe("healthy");
    expect(classifyHealth(10_000, 1000)?.confidence).toBe("healthy");
  });

  test("classifies low between 0.1 and 0.5", () => {
    expect(classifyHealth(100, 1000)?.confidence).toBe("low");
    expect(classifyHealth(499, 1000)?.confidence).toBe("low");
  });

  test("classifies insufficient below 0.1", () => {
    expect(classifyHealth(0, 1000)?.confidence).toBe("insufficient");
    expect(classifyHealth(99, 1000)?.confidence).toBe("insufficient");
  });

  test("matches the documented thresholds", () => {
    expect(HEALTHY_THRESHOLD).toBe(0.5);
    expect(LOW_THRESHOLD).toBe(0.1);
  });

  test("handles low-cadence per-bench expected_n (perp-funding case)", () => {
    // perp-funding declares expected_n: 3 (BTC, ETH, SOL series per venue).
    expect(classifyHealth(3, 3)?.confidence).toBe("healthy");
    expect(classifyHealth(2, 3)?.confidence).toBe("healthy"); // 0.67
    expect(classifyHealth(1, 3)?.confidence).toBe("low"); // 0.33
    expect(classifyHealth(0, 3)?.confidence).toBe("insufficient");
  });

  test("handles 4-source oracle-deviation case", () => {
    expect(classifyHealth(4, 4)?.confidence).toBe("healthy");
    expect(classifyHealth(3, 4)?.confidence).toBe("healthy"); // 0.75 (XRP/ADA/DOGE)
    expect(classifyHealth(1, 4)?.confidence).toBe("low"); // 0.25
  });
});

describe("aggregateConfidence", () => {
  test("returns undefined when expectedN is missing", () => {
    const results = [row("a", 1000)];
    expect(aggregateConfidence(results, undefined)).toBeUndefined();
  });

  test("ignores unavailable providers", () => {
    const results = [
      row("a", 1000, "unavailable"),
      row("b", 1000, "live"),
    ];
    expect(aggregateConfidence(results, 1000)?.confidence).toBe("healthy");
  });

  test("returns undefined when no live provider carries a sample count", () => {
    const results = [row("a", undefined), row("b", undefined)];
    expect(aggregateConfidence(results, 1000)).toBeUndefined();
  });

  test("uses the median ratio so one healthy provider does not mask a bad field", () => {
    const results = [
      row("a", 10), // 0.01 insufficient
      row("b", 50), // 0.05 insufficient
      row("c", 10_000), // healthy
    ];
    expect(aggregateConfidence(results, 1000)?.confidence).toBe(
      "insufficient",
    );
  });

  test("a healthy median wins regardless of outliers", () => {
    const results = [
      row("a", 0), // insufficient
      row("b", 1000), // healthy
      row("c", 5000), // healthy
    ];
    expect(aggregateConfidence(results, 1000)?.confidence).toBe("healthy");
  });
});

describe("formatHealthPct", () => {
  test("formats ratios as integer percent", () => {
    expect(formatHealthPct(0.75)).toBe("75%");
    expect(formatHealthPct(0.5)).toBe("50%");
    expect(formatHealthPct(0.09)).toBe("9%");
  });

  test("clamps very large ratios for display", () => {
    expect(formatHealthPct(50)).toBe("999%");
  });

  test("returns n/a for missing ratios", () => {
    expect(formatHealthPct(undefined)).toBe("n/a");
    expect(formatHealthPct(NaN)).toBe("n/a");
  });
});
