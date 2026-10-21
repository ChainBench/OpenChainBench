import { describe, expect, test } from "bun:test";
import { bridgeGaps, coverageWindow } from "./fetch-series";

describe("bridgeGaps", () => {
  test("interpolates interior nulls linearly", () => {
    expect(bridgeGaps([10, null, null, 40])).toEqual([10, 20, 30, 40]);
  });

  test("clamps leading and trailing nulls to nearest real value", () => {
    expect(bridgeGaps([null, null, 5, null])).toEqual([5, 5, 5, 5]);
  });

  test("all-null series collapses to empty", () => {
    expect(bridgeGaps([null, null])).toEqual([]);
  });

  test("dense numeric input passes through unchanged", () => {
    expect(bridgeGaps([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("coverageWindow", () => {
  test("drops leading buckets where under half the providers report", () => {
    expect(coverageWindow([[null, null, 1, 2], [null, 3, 4, 5], [null, null, null, 6]])).toEqual([2, 3]);
  });
  test("drops trailing buckets the same way", () => {
    expect(coverageWindow([[1, 2, null], [1, 2, null]])).toEqual([0, 1]);
  });
  test("null when nobody reports", () => {
    expect(coverageWindow([[null], [null]])).toBeNull();
  });
});
