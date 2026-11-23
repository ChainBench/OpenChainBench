/**
 * What the ledger does with a row that has no value.
 *
 * A metric panel holds one figure per provider, and a provider we could not
 * ask has none. The table read that absence as `?? 0`, which on a
 * higher-is-better board is not a missing reading, it is the worst possible
 * one: a refusal nobody gave, ranked last, with a data bar of zero width and
 * a number printed next to it.
 *
 * Bench 311 ran into this and routed around it rather than through it. Its
 * capability figures are published as columns, and its methodology says why:
 * "In a chart view the board renders one metric for every row, and a provider
 * with no reading for it is shown as a zero rather than left out, which would
 * state a refusal we never received." The columns were the workaround. This is
 * the fix, and with it a capability or a window can live in the view selector
 * on any board without lying about the rows it could not measure.
 *
 * Columns already had the convention right: a custom cell renders "-" when its
 * value is null. Everything here brings the panel path to that same rule.
 */

/** Sort key for a possibly-absent value.
 *
 *  Absent must sort LAST in both directions, which a single sentinel cannot
 *  do: on a lower-is-better board the worst value is the largest, and on a
 *  higher-is-better board it is the smallest. Using 0 for both is what put an
 *  unmeasured provider at the top of a latency board. */
export function sortableValue(
  value: number | null,
  higherIsBetter: boolean,
): number {
  if (value != null) return value;
  return higherIsBetter ? 0 : Number.POSITIVE_INFINITY;
}

/** Mean over the rows that have a value.
 *
 *  Counting an absence as zero does not only misplace that row: the field
 *  mean is the denominator of every other row's delta, so one unmeasured
 *  provider moves the percentage printed beside all the others. Returns 0
 *  when nothing was measured, which the caller already treats as "no delta
 *  to show". */
export function fieldMean(values: (number | null)[]): number {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (present.length === 0) return 0;
  return present.reduce((s, v) => s + v, 0) / present.length;
}

/** Scale for the inline data bars: the largest value actually measured.
 *
 *  Infinite sentinels from `sortableValue` must never reach this, or every
 *  real bar collapses to nothing. Returns 1 when there is nothing to scale
 *  against, so a division by it is still safe. */
export function barScale(values: (number | null)[]): number {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (present.length === 0) return 1;
  return Math.max(...present, 0) || 1;
}
