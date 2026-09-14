import { describe, expect, test } from "bun:test";
import { deltaBarsFromCumulative } from "./perp-venue-external";

describe("deltaBarsFromCumulative", () => {
  test("drops re-index jumps in a cumulative counter (real Gains series, Sep 2026)", () => {
    // backend-global.gains.trade/api/stats?chainId=42161, leveraged_volume
    // per day. The +$29.2B step on 09-03 and +$26.6B on 09-07 were history
    // re-indexes on Gains' side; the page rendered them as $30B days.
    const series = [
      ["2026-09-01", 0.543e9],
      ["2026-09-02", 0.572e9],
      ["2026-09-03", 29.772e9],
      ["2026-09-04", 29.837e9],
      ["2026-09-05", 29.867e9],
      ["2026-09-06", 29.928e9],
      ["2026-09-07", 56.519e9],
      ["2026-09-08", 56.565e9],
      ["2026-09-09", 56.615e9],
      ["2026-09-10", 56.687e9],
      ["2026-09-11", 56.801e9],
      ["2026-09-12", 56.837e9],
      ["2026-09-13", 56.879e9],
      ["2026-09-14", 57.342e9],
    ].map(([date, value]) => ({ date: date as string, value: value as number }));

    const bars = deltaBarsFromCumulative(series);
    const dates = bars.map((b) => b.date);
    expect(dates).not.toContain("2026-09-03");
    expect(dates).not.toContain("2026-09-07");
    expect(bars.length).toBe(11);
    expect(Math.max(...bars.map((b) => b.valueUsd))).toBeLessThan(1e9);
    // A genuinely busy day (09-14, +$463M) survives: it is under 8x the median.
    expect(dates).toContain("2026-09-14");
  });

  test("keeps everything when there are too few points to judge", () => {
    const bars = deltaBarsFromCumulative([
      { date: "2026-09-01", value: 100 },
      { date: "2026-09-02", value: 200 },
      { date: "2026-09-03", value: 10_000 },
    ]);
    expect(bars.map((b) => b.valueUsd)).toEqual([100, 9_800]);
  });

  test("ignores non-positive deltas and cuts the date to the day", () => {
    const bars = deltaBarsFromCumulative([
      { date: "2026-09-01T00:00:00Z", value: 100 },
      { date: "2026-09-02T00:00:00Z", value: 90 },
      { date: "2026-09-03T00:00:00Z", value: 150 },
      { date: "2026-09-04T00:00:00Z", value: 210 },
      { date: "2026-09-05T00:00:00Z", value: 260 },
    ]);
    expect(bars).toEqual([
      { date: "2026-09-03", valueUsd: 60 },
      { date: "2026-09-04", valueUsd: 60 },
      { date: "2026-09-05", valueUsd: 50 },
    ]);
  });
});
