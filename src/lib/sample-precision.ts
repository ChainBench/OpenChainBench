/**
 * How finely a rate may be printed, given the sample behind it.
 *
 * The ledger printed every success rate with two decimals. On a bench
 * sampling 2,880 times a day that is earned. On the bridge execution benches,
 * which run roughly 70 to 95 executions a week, it is not: all four providers
 * read "100.00%", two decimals off a sample whose finest possible step is
 * 1/68, about 1.5%. The column distinguished nothing while looking precise,
 * and a reader could not tell the difference between 100% of 68 and 100% of
 * 68,000.
 *
 * Kept out of the component so it can be tested without rendering, and
 * because the same rule should apply anywhere else a rate meets a sample.
 */

/**
 * Decimal places a rate from `sampleSize` observations can support.
 *
 * The finest step a rate from n observations can take is 1/n, so the useful
 * precision is log10(n) digits, less the two the percentage scale already
 * carries. Capped at two, which is as fine as this ledger has ever shown, and
 * floored at zero.
 *
 *   n = 68     -> 0   (steps of 1.5 points; "100%" is the honest rendering)
 *   n = 1,000  -> 1   (steps of 0.1 points)
 *   n = 2,880  -> 2   (the 30-second probe benches keep what they had)
 *
 * An unknown sample keeps two decimals: there is nothing better to go on, and
 * silently coarsening a figure whose sample we cannot see would be its own
 * kind of wrong.
 */
export function rateDecimals(sampleSize: number | null | undefined): number {
  if (sampleSize == null || !Number.isFinite(sampleSize) || sampleSize <= 0) return 2;
  return Math.min(2, Math.max(0, Math.ceil(Math.log10(sampleSize)) - 2));
}

/**
 * What a success rate rests on, for the cell's tooltip.
 *
 * "100%" is the same string whether it came from 68 measurements or 68,000,
 * and the column cannot show the difference. When nothing failed, the ceiling
 * the sample can actually support is stated: with 68 observations the next
 * distinguishable value below 100% is 98.5%, so a reader knows the figure is
 * "no failure seen", not "failure impossible".
 */
export function successTitle(
  successRate: number,
  sampleSize: number | null | undefined,
): string | undefined {
  if (sampleSize == null || !Number.isFinite(sampleSize) || sampleSize <= 0) return undefined;
  const failed = Math.round(sampleSize * (1 - successRate / 100));
  const n = Math.round(sampleSize).toLocaleString("en-US");
  if (failed > 0) {
    return `${failed.toLocaleString("en-US")} failed of ${n} measurements.`;
  }
  const floor = 100 - 100 / sampleSize;
  return `No failure observed in ${n} measurements. A sample this size cannot distinguish a rate above ${floor.toFixed(1)}%.`;
}
