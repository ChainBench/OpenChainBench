import { describe, expect, test } from "bun:test";
import { rateDecimals, successTitle } from "./sample-precision";

describe("a rate is not printed finer than its sample can resolve", () => {
  test("the bridge execution benches lose their false decimals", () => {
    // Four bridges, roughly 70 to 95 executions a week, every one of them
    // reading "100.00%". The finest step a rate from 68 observations can take
    // is 1/68, about 1.5 points, so two decimals claimed a precision two
    // orders of magnitude finer than the sample.
    expect(rateDecimals(68)).toBe(0);
    expect(rateDecimals(93)).toBe(0);
    expect((100).toFixed(rateDecimals(68))).toBe("100");
  });

  test("the 30-second probe benches keep what they had", () => {
    // 2,880 samples a day is the cadence the aggregator and RPC benches run
    // at, and it earns both decimals.
    expect(rateDecimals(2880)).toBe(2);
    expect(rateDecimals(100_000)).toBe(2);
  });

  test("precision climbs with the sample, one digit at a time", () => {
    expect(rateDecimals(100)).toBe(0);
    expect(rateDecimals(1000)).toBe(1);
    expect(rateDecimals(10_000)).toBe(2);
  });

  test("an unknown sample keeps two decimals rather than being coarsened silently", () => {
    // Coarsening a figure whose sample we cannot see would be its own kind of
    // wrong: we would be asserting imprecision we have not established.
    expect(rateDecimals(null)).toBe(2);
    expect(rateDecimals(undefined)).toBe(2);
    expect(rateDecimals(0)).toBe(2);
    expect(rateDecimals(Number.NaN)).toBe(2);
  });
});

describe("the tooltip says what the percentage rests on", () => {
  test("no failure names the ceiling the sample can support", () => {
    // "100%" reads as "cannot fail". With 68 observations the next
    // distinguishable value below 100% is 98.5%, and the reader should see it.
    const t = successTitle(100, 68);
    expect(t).toContain("68 measurements");
    expect(t).toContain("98.5%");
  });

  test("failures are counted rather than implied", () => {
    expect(successTitle(98, 100)).toBe("2 failed of 100 measurements.");
  });

  test("silent when there is no sample to describe", () => {
    expect(successTitle(100, null)).toBeUndefined();
    expect(successTitle(100, 0)).toBeUndefined();
  });

  test("100% of 68 and 100% of 68,000 no longer read identically", () => {
    expect(successTitle(100, 68)).not.toBe(successTitle(100, 68_000));
  });
});
