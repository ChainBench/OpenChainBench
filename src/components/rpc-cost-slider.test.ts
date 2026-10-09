import { describe, expect, test } from "bun:test";
import {
  fmtRequests,
  fmtUSD,
  requestsAt,
  roundRequests,
  stepOf,
} from "@/components/rpc-cost-slider";

const FLOOR = 100_000;
const CEILING = 5_000_000_000;

/**
 * The slider's track is logarithmic across four and a half decades, and the
 * three volumes the ledger publishes are marked on it so a reader can stand
 * on one and check the panel against the table. That only works if standing
 * on one is exact: routing the tick through the log scale and back landed
 * 99.5M for the "100M" mark, which is a 0.5% different question.
 */
describe("the volume track", () => {
  test("spans exactly the emitted range", () => {
    expect(requestsAt(0, FLOOR, CEILING)).toBeCloseTo(FLOOR, 6);
    expect(requestsAt(1000, FLOOR, CEILING)).toBeCloseTo(CEILING, 6);
  });

  test("is logarithmic, so the entry plans are not crushed into the first pixels", () => {
    // Half the track is the geometric mean, not the arithmetic one. A linear
    // track would put 2.5B at the midpoint and spend 98% of its length above
    // 100M, where the readings barely move.
    const mid = requestsAt(500, FLOOR, CEILING);
    expect(mid).toBeCloseTo(Math.sqrt(FLOOR * CEILING), 0);
    expect(mid).toBeLessThan(1e9);
  });

  test("round-trips a position", () => {
    for (const step of [0, 1, 250, 426, 638, 999, 1000]) {
      expect(stepOf(requestsAt(step, FLOOR, CEILING), FLOOR, CEILING)).toBe(step);
    }
  });

  test("clamps rather than running off either end", () => {
    expect(requestsAt(-50, FLOOR, CEILING)).toBe(FLOOR);
    expect(requestsAt(5000, FLOOR, CEILING)).toBe(CEILING);
    expect(stepOf(1, FLOOR, CEILING)).toBe(0);
    expect(stepOf(1e12, FLOOR, CEILING)).toBe(1000);
  });

  test("a published volume stays itself", () => {
    // Held as the volume rather than as a track position, which is why this
    // passes. Through the step it read 99,500,000.
    for (const r of [10e6, 100e6, 1000e6]) {
      const step = stepOf(r, FLOOR, CEILING);
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThanOrEqual(1000);
    }
  });
});

describe("rounding the volume a reader lands on", () => {
  test("keeps three significant figures", () => {
    expect(roundRequests(41_237_905)).toBe(41_200_000);
    expect(roundRequests(999_499)).toBe(999_000);
    expect(roundRequests(1_004_070)).toBe(1_000_000);
  });

  test("never returns a negative or a NaN volume", () => {
    expect(roundRequests(0)).toBe(0);
    expect(roundRequests(-5)).toBe(0);
    expect(roundRequests(Number.NaN)).toBe(0);
  });
});

describe("formatting", () => {
  test("volumes read the way a reader would say them", () => {
    expect(fmtRequests(100_000)).toBe("100k");
    expect(fmtRequests(10e6)).toBe("10M");
    expect(fmtRequests(41.2e6)).toBe("41.2M");
    expect(fmtRequests(1e9)).toBe("1B");
    expect(fmtRequests(5e9)).toBe("5B");
  });

  test("a bill keeps its cents while they matter and drops them when they do not", () => {
    expect(fmtUSD(22.71)).toBe("$22.71");
    expect(fmtUSD(49)).toBe("$49");
    expect(fmtUSD(199)).toBe("$199");
    expect(fmtUSD(9499.000790941776)).toBe("$9,499");
  });

  test("a missing price is a dash and a real zero is a zero", () => {
    // The two cases this bench already got wrong once, on the same board.
    expect(fmtUSD(null)).toBe("-");
    expect(fmtUSD(0)).toBe("$0");
  });
});
