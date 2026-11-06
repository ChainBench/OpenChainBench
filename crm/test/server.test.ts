import { describe, expect, test } from "bun:test";
import { alignRange, daysToFull } from "@/lib/server";

describe("daysToFull", () => {
  test("a falling free space has a date", () => {
    expect(daysToFull(70e9, -3.5e9)).toBeCloseTo(20);
  });
  test("flat, growing or unknown free space has none", () => {
    expect(daysToFull(70e9, 0)).toBeNull();
    expect(daysToFull(70e9, 2e9)).toBeNull();
    expect(daysToFull(70e9, null)).toBeNull();
    expect(daysToFull(70e9, NaN)).toBeNull();
  });
});

describe("alignRange", () => {
  test("missing steps come back as NaN, not shifted", () => {
    const got = alignRange([{ values: [[100, "1"], [300, "3"]] }], [100, 200, 300]);
    expect(got[0]).toBe(1);
    expect(Number.isNaN(got[1])).toBe(true);
    expect(got[2]).toBe(3);
  });
  test("an absent series is all NaN", () => {
    expect(alignRange([], [1, 2]).every(Number.isNaN)).toBe(true);
  });
});
