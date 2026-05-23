"use client";

import { useState } from "react";

/**
 * Per-chart "providers the reader chose to hide" state.
 *
 * Each chart (ranked-bar, distribution, donut) was hand-rolling this
 * pattern: a controlled / uncontrolled switch + a local `Set<string>`
 * fallback + a toggle that adds-or-removes. Three copies of the same
 * 25 lines, with the same edge cases to keep in sync. This hook is the
 * single source of truth.
 *
 * - When the parent passes `controlled` + `onToggle`, the hook defers
 *   to the parent so the choice survives view switches.
 * - When no controls are passed (chart embedded standalone, e.g. on a
 *   product page), the hook manages a local set and the exclusion is
 *   scoped to that chart's lifetime.
 */
export function useChartExclusion(
  controlled?: Set<string>,
  onToggle?: (slug: string) => void,
  onReset?: () => void,
): {
  excluded: Set<string>;
  toggle: (slug: string) => void;
  reset: () => void;
} {
  const [internal, setInternal] = useState<Set<string>>(() => new Set());
  const excluded = controlled ?? internal;

  const toggle = (slug: string) => {
    if (onToggle) {
      onToggle(slug);
      return;
    }
    setInternal((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const reset = () => {
    if (onReset) {
      onReset();
      return;
    }
    setInternal(new Set());
  };

  return { excluded, toggle, reset };
}
