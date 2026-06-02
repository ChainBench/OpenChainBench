"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Shared Top-N selector state for chart views. Sized off the count
 * of providers that actually have data on the active metric — passing
 * the raw cohort makes the toolbar offer useless options (Top 10 when
 * only 7 providers scored). The hook curates the option set so an N
 * button only appears when at least N+1 providers exist, plus an
 * "All" anchor whenever any filtering option is offered.
 *
 * Returned `topN`:
 *   - `null` means "show every provider that has data"
 *   - `number` means "slice to the first N (already sorted upstream)"
 *
 * Returned `topNOptions` is the exact button list the chart should
 * render, in order. Hide the toolbar entirely when the array is empty
 * (cohort too sparse for filtering to matter).
 *
 * `useEffect` gracefully resets to "All" when the active selection
 * disappears from the option set (reader swapped to a sparser panel).
 */
export function useTopN(scoredCount: number): {
  topN: number | null;
  setTopN: (n: number | null) => void;
  topNOptions: (number | null)[];
} {
  const topNOptions = useMemo<(number | null)[]>(() => {
    const opts: (number | null)[] = [];
    for (const n of [5, 10, 20]) if (n < scoredCount) opts.push(n);
    if (opts.length > 0) opts.push(null);
    return opts;
  }, [scoredCount]);
  const initial = topNOptions[0] ?? null;
  const [topN, setTopN] = useState<number | null>(initial);
  useEffect(() => {
    if (topN == null) return;
    if (!topNOptions.includes(topN)) setTopN(null);
  }, [topNOptions, topN]);
  return { topN, setTopN, topNOptions };
}
