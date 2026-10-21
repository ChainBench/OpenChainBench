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

const worse = (higherIsBetter: boolean) => (higherIsBetter ? -Infinity : Infinity);

/**
 * ranks[step][row] that only change when a lead holds. Each row is scored
 * by its value averaged over +-`window` readings, and two neighbours swap
 * only when the lower one beats the upper one by more than `margin` of
 * their size. Raw ranks flipped back and forth whenever two providers ran
 * level (swaps-count-big: Axiom and Fomo traded places on most readings),
 * and every flip was a crossing the viewer had to untangle.
 */
export function stableRanks(series: number[][], higherIsBetter: boolean, window = 1, margin = 0.01): number[][] {
  const steps = Math.max(0, ...series.map((v) => v.length));
  const score = (j: number, i: number) => {
    let s = 0, n = 0;
    for (let k = i - window; k <= i + window; k++) {
      const v = series[j][Math.max(0, Math.min(steps - 1, k))];
      if (Number.isFinite(v)) { s += v; n++; }
    }
    return n ? s / n : worse(higherIsBetter);
  };
  const beats = (a: number, b: number) => {
    if (!Number.isFinite(b)) return Number.isFinite(a);
    if (!Number.isFinite(a)) return false;
    const d = higherIsBetter ? a - b : b - a;
    return d > margin * Math.max(Math.abs(a), Math.abs(b));
  };
  const out: number[][] = [];
  let order: number[] = [];
  for (let i = 0; i < steps; i++) {
    const s = series.map((_, j) => score(j, i));
    if (i === 0) {
      order = s.map((_, j) => j).sort((a, b) => (higherIsBetter ? s[b] - s[a] : s[a] - s[b]) || a - b);
      order.sort((a, b) => (Number.isFinite(s[a]) ? 0 : 1) - (Number.isFinite(s[b]) ? 0 : 1));
    } else {
      // Bubble passes from the previous order: only real overtakes move.
      for (let pass = 0; pass < order.length; pass++) {
        let moved = false;
        for (let k = 0; k + 1 < order.length; k++) {
          if (beats(s[order[k + 1]], s[order[k]])) {
            [order[k], order[k + 1]] = [order[k + 1], order[k]];
            moved = true;
          }
        }
        if (!moved) break;
      }
    }
    const r: number[] = [];
    order.forEach((j, k) => (r[j] = k));
    out.push(r);
  }
  return out;
}

const easeInOut = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
};

/**
 * Row j's position at fractional step `step`: every rank change becomes
 * one eased glide of `swapFrames` video frames that lands on the reading
 * where it happens (the values cross on the way to that reading). A glide
 * centred on the reading never finished when the change came on the last
 * one: the clip ended with two rows stacked half a slot apart. Changes
 * add up, so two overtakes in quick succession chain instead of snapping.
 */
export function swapRank(ranks: number[][], j: number, step: number, framesPerStep: number, swapFrames = 16): number {
  if (!ranks.length) return j;
  let pos = ranks[0][j];
  for (let i = 1; i < ranks.length; i++) {
    const d = ranks[i][j] - ranks[i - 1][j];
    if (!d) continue;
    // Glide over the swapFrames that end on reading i, never starting
    // before the first reading (a change on reading 1 would otherwise be
    // half done while the clip still holds reading 0); an early change
    // keeps its full length and lands a little after its reading.
    // A jump of several ranks gets a longer glide (up to 3x): Paradex
    // climbing seven places in 18 frames crossed the podium in two.
    const dur = swapFrames * Math.min(3, 1 + 0.4 * (Math.abs(d) - 1));
    const start = Math.max(0, i * framesPerStep - dur);
    const p = (step * framesPerStep - start) / dur;
    if (p <= 0 && i * framesPerStep - swapFrames * 3 > step * framesPerStep) break;
    if (p <= 0) continue;
    pos += d * easeInOut(p);
  }
  return pos;
}

/** Readings that cover about `seconds` of video, for stableRanks' window. */
export function readingsFor(seconds: number, framesPerStep: number, fps = 30): number {
  return Math.max(0, Math.min(3, Math.round((seconds * fps) / Math.max(1, framesPerStep))));
}

/**
 * Opacity of a row moving down while another row passes it, by their
 * distance in ranks: 0.3 when level, back to 1 at 0.8 rank apart. The
 * row going up stays bright and on top, so one name always reads.
 */
export function crossingOpacity(near: number): number {
  if (!(near < 0.8)) return 1;
  const f = near / 0.8;
  return 0.3 + 0.7 * f * f;
}

/**
 * Per-row opacity while rows pass each other: of two rows closer than
 * 0.8 rank, the one that will end lower (its rank a few readings ahead)
 * steps back. Judging by direction of travel missed two rows climbing at
 * different speeds (netfees podium list, Robinhood Chain / Scroll).
 */
export function crossingFades(ranks: number[][], step: number, pos: number[], framesPerStep: number, swapFrames = 16): number[] {
  const ahead = ranks[Math.min(ranks.length - 1, Math.ceil(step + (3 * swapFrames) / Math.max(1, framesPerStep)))] ?? [];
  return pos.map((p, j) => {
    let op = 1;
    pos.forEach((q, k) => {
      if (k !== j && (ahead[j] ?? j) > (ahead[k] ?? k)) op = Math.min(op, crossingOpacity(Math.abs(p - q)));
    });
    return op;
  });
}
