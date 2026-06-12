"use client";

import { useMemo, useState } from "react";

/**
 * Shared Top-N selector state for chart views. Sized off the count
 * of providers that actually have data on the active metric.
 *
 * Two control modes:
 *   - Uncontrolled (default): the hook owns the value via useState.
 *   - Controlled via `options.external`: the parent owns the value so
 *     every chart view + the ledger can share one Top-N selection.
 *
 * `options.disabled` short-circuits the option set (returns []) which
 * hides the selector entirely.
 */
export function useTopN(
  scoredCount: number,
  options?: {
    disabled?: boolean;
    external?: { topN: number | null; setTopN: (n: number | null) => void };
  },
): {
  topN: number | null;
  setTopN: (n: number | null) => void;
  topNOptions: (number | null)[];
} {
  const disabled = options?.disabled === true;
  const external = options?.external;
  const topNOptions = useMemo<(number | null)[]>(() => {
    if (disabled) return [];
    const opts: (number | null)[] = [];
    for (const n of [5, 10, 20]) if (n < scoredCount) opts.push(n);
    if (opts.length > 0) opts.push(null);
    return opts;
  }, [scoredCount, disabled]);
  const initial = topNOptions[0] ?? null;
  const [topNLocal, setTopNLocal] = useState<number | null>(initial);
  const topN = external ? external.topN : topNLocal;
  const setTopN = external ? external.setTopN : setTopNLocal;
  // A stale local value (option set shrank under it) resets during
  // render rather than via a setState-in-effect cascade.
  if (!external && topNLocal != null && !topNOptions.includes(topNLocal)) {
    setTopNLocal(null);
  }
  return { topN, setTopN, topNOptions };
}
