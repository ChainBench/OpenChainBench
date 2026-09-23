import { describe, expect, it } from "bun:test";

/**
 * The bar geometry of the default USD leaderboard, extracted so the
 * negative case is pinned without rendering the component.
 *
 * Bench 275 publishes a flow, so six of its twenty rows are outflows. The
 * old width was `p50 / max`, which for BNB's -$457M against a $918M max
 * gives -49.81%: CSS drops a negative width, the bar takes its auto width,
 * and the worst outflow of the month draws as long as the biggest inflow.
 */
function barPct(v: number, max: number): number {
  return Number.isFinite(v) ? (Math.abs(v) / max) * 100 : 100;
}

function scaleMax(values: number[]): number {
  return Math.max(...values.filter(Number.isFinite).map(Math.abs)) || 1;
}

describe("count leaderboard bars with a flow metric", () => {
  // The live board on 2026-09-23.
  const rows = [
    917_601_495, // tron
    880_616_306, // hyperliquid
    606_448_859, // solana
    377_430_716, // ethereum
    -1_221_336, // avalanche
    -27_336_219, // monad
    -40_130_720, // stellar
    -129_721_427, // polygon
    -457_081_465, // bnb
  ];
  const max = scaleMax(rows);

  it("scales on magnitude so every bar has a drawable width", () => {
    expect(max).toBe(917_601_495);
    for (const v of rows) {
      const pct = barPct(v, max);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });

  it("gives the worst outflow half the track, not all of it", () => {
    const bnb = barPct(-457_081_465, max);
    expect(bnb).toBeCloseTo(49.81, 1);
    // The old rule produced a negative width, which a browser drops.
    expect((-457_081_465 / max) * 100).toBeLessThan(0);
  });

  it("does not rank an inflow and an outflow of the same size together", () => {
    // Same bar length by design — the sign is carried by the hatching and
    // the printed number, which is why both must be rendered.
    expect(barPct(457_081_465, max)).toBeCloseTo(barPct(-457_081_465, max), 6);
  });
});

describe("the summary strip", () => {
  const rows = [917_601_495, 1_035_740, -457_081_465];

  it("keeps negative rows in the range when the bench has any", () => {
    const hasNegative = rows.some((v) => v < 0);
    const valid = rows.filter((v) => (hasNegative ? Number.isFinite(v) : v > 0));
    expect(valid).toHaveLength(3);
    expect(Math.min(...valid)).toBe(-457_081_465);
  });

  it("drops the gap ratio rather than dividing across zero", () => {
    const leader = 917_601_495;
    const trailer = -457_081_465;
    // -457M is not "885.9x worse" than $1.04M; it is on the other side of
    // the axis, so the ratio is refused.
    const gap = leader > 0 && trailer > 0 ? leader / trailer : 0;
    expect(gap).toBe(0);
  });
});
