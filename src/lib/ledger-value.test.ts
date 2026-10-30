import { describe, expect, it } from "bun:test";

import { barScale, fieldMean, sortableValue } from "@/lib/ledger-value";

/**
 * The case these exist for, in full, because it is the reason bench 311 was
 * built around the problem instead of through it.
 *
 * A metric panel holds one figure per provider. A provider we could not ask
 * has none, and the table read that as `?? 0`. On a higher-is-better board a
 * zero is not an absence, it is the worst possible reading, printed as a
 * number with a bar beside it. Bench 311's methodology states the
 * consequence plainly: "a provider with no reading for it is shown as a zero
 * rather than left out, which would state a refusal we never received", and
 * its capability figures were published as columns to avoid it.
 *
 * The same `?? 0` was also in the field mean, which is the denominator of
 * every row's delta, so one unmeasured provider moved the percentage printed
 * next to all the others.
 */
describe("sortableValue", () => {
  it("sorts a missing value last on a lower-is-better board", () => {
    // Latency. The worst place is the largest number, and 0 would have put an
    // unmeasured provider at the top of the table.
    expect(sortableValue(null, false)).toBe(Number.POSITIVE_INFINITY);
    expect(sortableValue(null, false)).toBeGreaterThan(sortableValue(99999, false));
  });

  it("sorts a missing value last on a higher-is-better board", () => {
    // Capability, in percent. Here the worst place IS zero, which is why one
    // sentinel cannot serve both directions.
    expect(sortableValue(null, true)).toBe(0);
    expect(sortableValue(null, true)).toBeLessThan(sortableValue(0.1, true));
  });

  it("passes a real zero through unchanged", () => {
    // A measured 0 is a refusal we did receive, and it must keep its place:
    // a getLogs window of 0 blocks means the narrowest span was refused,
    // which is a fact about the provider rather than about our access.
    expect(sortableValue(0, true)).toBe(0);
    expect(sortableValue(0, false)).toBe(0);
  });
});

describe("fieldMean", () => {
  it("excludes missing rows instead of counting them as zero", () => {
    // Four providers, one unmeasured. The mean of what was measured is 100.
    // Counting the absence drags it to 75 and every other row's delta with it.
    expect(fieldMean([100, 100, 100, null])).toBe(100);
  });

  it("is the plain mean when nothing is missing", () => {
    expect(fieldMean([10, 20, 30])).toBe(20);
  });

  it("returns zero when nothing was measured", () => {
    // The caller reads 0 as "no delta to show" rather than dividing by it.
    expect(fieldMean([null, null])).toBe(0);
    expect(fieldMean([])).toBe(0);
  });

  it("ignores the infinite sentinel if one ever reaches it", () => {
    // sortableValue's lower-is-better sentinel is Infinity. If the two paths
    // were ever crossed, a single Infinity would make the mean Infinity and
    // every delta NaN, which renders as nothing at all and looks like a data
    // outage rather than a bug.
    expect(fieldMean([10, 20, Number.POSITIVE_INFINITY])).toBe(15);
  });
});

describe("barScale", () => {
  it("scales to the largest measured value", () => {
    expect(barScale([10, 40, null])).toBe(40);
  });

  it("never returns zero, so dividing by it stays safe", () => {
    expect(barScale([])).toBe(1);
    expect(barScale([null, null])).toBe(1);
    expect(barScale([0, 0])).toBe(1);
  });

  it("refuses an infinite sentinel, which would flatten every real bar", () => {
    // This is the failure that would be hardest to read on the page: every
    // bar becomes a sliver and nothing errors.
    expect(barScale([10, 40, Number.POSITIVE_INFINITY])).toBe(40);
  });
});

describe("the three together, on the shape that caused this", () => {
  it("one unasked provider changes neither the mean nor the scale", () => {
    // Bench 311's robinhood tab: five providers, one of which we could not
    // ask on that chain. Measured values are the getLogs windows.
    const measured = [500, 10_000, 10_000, 1_000_000];
    const withGap: (number | null)[] = [...measured, null];
    expect(fieldMean(withGap)).toBe(fieldMean(measured));
    expect(barScale(withGap)).toBe(barScale(measured));
    // And the unasked row is last rather than first on a board where more
    // is better.
    const keys = withGap.map((v) => sortableValue(v, true));
    expect(Math.min(...keys)).toBe(0);
    expect(keys[keys.length - 1]).toBe(0);
  });
});
