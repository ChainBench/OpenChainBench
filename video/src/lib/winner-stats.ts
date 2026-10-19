import type { BenchPayload } from "../BarChartRace/mock-data";

/**
 * Per-provider leader stats — how many timestamps each provider held #1.
 * Powers the ResultsBoard composition and the crown emoji shown live on
 * Podium / Donut while the leader holds the lead.
 *
 * Tie-breaking is deterministic (first in `bench.providers` order wins)
 * because the race itself uses stable sort upstream — same data, same
 * leader, same crown.
 */

export type WinnerStat = {
  slug: string;
  name: string;
  color: string;
  logo?: string;
  /** Number of timestamps this provider was the leader. */
  count: number;
  /** Fraction of the timeline this provider led, in [0,1]. */
  share: number;
};


export function computeWinnerStats(bench: BenchPayload): WinnerStat[] {
  const total = bench.timestamps.length;
  if (total === 0 || bench.providers.length === 0) return [];

  const counts = new Map<string, number>();
  for (let i = 0; i < total; i++) {
    const winner = pickWinnerAt(bench, i);
    if (winner) counts.set(winner.slug, (counts.get(winner.slug) ?? 0) + 1);
  }

  const result: WinnerStat[] = [];
  for (const p of bench.providers) {
    const count = counts.get(p.slug) ?? 0;
    if (count === 0) continue;
    result.push({
      slug: p.slug,
      name: p.name,
      color: p.color,
      logo: p.logo,
      count,
      share: count / total,
    });
  }
  result.sort((a, b) => b.count - a.count);
  return result;
}

/** Who is leading at a specific timestamp index. */
export function pickWinnerAt(bench: BenchPayload, i: number) {
  if (bench.providers.length === 0) return null;
  let winner = bench.providers[0];
  let winnerVal = winner.values[i];
  for (let j = 1; j < bench.providers.length; j++) {
    const v = bench.providers[j].values[i];
    const wins = bench.higherIsBetter ? v > winnerVal : v < winnerVal;
    if (wins) {
      winner = bench.providers[j];
      winnerVal = v;
    }
  }
  return winner;
}

/**
 * Spacing between consecutive timestamps. The series API downsamples
 * (e.g. 30d = 60 points 12h apart), so a timestamp COUNT is meaningless
 * on its own — labels must multiply by this step to get real time.
 * (Old code labeled raw counts: 24 buckets of 12h read "24 hours"
 * instead of 12 days.)
 */
export function timestampStepMs(bench: BenchPayload): number {
  if (bench.timestamps.length < 2) return 24 * 3600_000;
  return bench.timestamps[1] - bench.timestamps[0];
}

/** Human duration for `count` buckets of `stepMs` ("12 days", "3.5 hours"). */
export function winnerLabel(count: number, stepMs: number): string {
  return fmtSpan(count * stepMs);
}

export function fmtSpan(ms: number): string {
  const fmt = (v: number) => {
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  };
  const days = ms / 86_400_000;
  if (days >= 2) return `${fmt(days)} days`;
  const hours = ms / 3_600_000;
  if (hours >= 2) return `${fmt(hours)} hours`;
  const minutes = ms / 60_000;
  if (minutes >= 2) return `${fmt(minutes)} mins`;
  return minutes === 1 ? "1 min" : `${fmt(minutes)} min`;
}
