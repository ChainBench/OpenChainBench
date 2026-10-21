/**
 * Continuous ranks for rows that reorder over time.
 *
 * Sorting rows by the current value and placing them at their index made
 * them teleport whenever two values crossed (418 px in one frame on the bar
 * race, 148 px on Distribution, lab motion pass). Instead: fix each row's
 * rank at every reading, interpolate between readings, and average over a
 * short window so a swap becomes a glide.
 */

/** ranks[step][row] for series[row][step]; ties keep input order. */
export function rankTable(series: number[][], higherIsBetter: boolean): number[][] {
  const steps = Math.max(0, ...series.map((v) => v.length));
  const out: number[][] = [];
  for (let i = 0; i < steps; i++) {
    const order = series
      .map((v, j) => ({ j, v: Number.isFinite(v[i]) ? v[i] : higherIsBetter ? -Infinity : Infinity }))
      .sort((a, b) => (higherIsBetter ? b.v - a.v : a.v - b.v) || a.j - b.j);
    const r: number[] = [];
    order.forEach((o, k) => (r[o.j] = k));
    out.push(r);
  }
  return out;
}

/**
 * Rank of row j at fractional step `step`, averaged over +-`frames` video
 * frames (default 9, 0.6 s at 30 fps).
 */
export function smoothRank(ranks: number[][], j: number, step: number, framesPerStep: number, frames = 9): number {
  const last = ranks.length - 1;
  if (last < 0) return j;
  const at = (s: number) => {
    const c = Math.max(0, Math.min(last, s));
    const lo = Math.floor(c), hi = Math.min(lo + 1, last);
    return ranks[lo][j] + (ranks[hi][j] - ranks[lo][j]) * (c - lo);
  };
  const half = Math.max(0.5, frames / Math.max(1e-6, framesPerStep));
  const N = 8;
  let sum = 0;
  for (let k = 0; k <= N; k++) sum += at(step - half + (2 * half * k) / N);
  return sum / (N + 1);
}
