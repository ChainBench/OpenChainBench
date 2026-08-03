import { describe, expect, test } from "bun:test";
import { downsample, MINI_CHART_POINTS } from "./downsample";

describe("downsample", () => {
  test("returns input as-is (filtered) when length <= target", () => {
    expect(downsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
    expect(downsample([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  test("filters nulls out when no downsampling needed", () => {
    expect(downsample([1, null, 3, null, 5], 10)).toEqual([1, 3, 5]);
  });

  test("reduces to target number of points when no nulls", () => {
    const input = Array.from({ length: 100 }, (_, i) => i + 1);
    const out = downsample(input, 10);
    expect(out.length).toBe(10);
  });

  test("output may be less than target when buckets are all-null", () => {
    // 4 values → 2 buckets; second all-null → 1 output point
    const out = downsample([10, 20, null, null], 2);
    expect(out.length).toBeLessThan(2);
  });

  test("target=1 returns mean of all values", () => {
    const out = downsample([1, 2, 3, 4, 5], 1);
    expect(out).toEqual([3]);
  });

  test("target=0 returns empty array", () => {
    expect(downsample([1, 2, 3], 0)).toEqual([]);
  });

  test("bucket mean: each output point is the mean of its bucket", () => {
    // 4 values → 2 buckets of 2: [1,2]=1.5, [3,4]=3.5
    const out = downsample([1, 2, 3, 4], 2);
    expect(out).toEqual([1.5, 3.5]);
  });

  test("nulls inside a bucket are excluded from the mean", () => {
    // 6 values, target 2 → bucketSize=3
    // bucket 0: [10, null, 20] → mean of [10,20] = 15
    // bucket 1: [30, null, 60] → mean of [30,60] = 45
    const out = downsample([10, null, 20, 30, null, 60], 2);
    expect(out[0]).toBe(15);
    expect(out[1]).toBe(45);
  });

  test("bucket with all nulls is omitted from output", () => {
    // 4 values → 2 buckets; second bucket all null → only 1 output
    const out = downsample([10, 20, null, null], 2);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(15);
  });

  test("empty array returns empty", () => {
    expect(downsample([], 10)).toEqual([]);
  });

  test("all-null array returns empty", () => {
    expect(downsample([null, null, null], 10)).toEqual([]);
  });

  test("single value passthrough", () => {
    expect(downsample([42], 5)).toEqual([42]);
  });

  test("preserves shape: monotone series stays monotone after downsampling", () => {
    const input = Array.from({ length: 200 }, (_, i) => i * 2);
    const out = downsample(input, 20);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
    }
  });

  test("uniform series: all output points equal the same value", () => {
    const input = Array.from({ length: 50 }, () => 7);
    const out = downsample(input, 10);
    expect(out.every((v) => v === 7)).toBe(true);
  });
});

describe("MINI_CHART_POINTS constant", () => {
  test("is a positive integer", () => {
    expect(MINI_CHART_POINTS).toBeGreaterThan(0);
    expect(Number.isInteger(MINI_CHART_POINTS)).toBe(true);
  });
});
