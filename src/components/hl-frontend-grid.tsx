"use client";

import { useMemo, useState } from "react";
import type {
  HlHistoryFrontendCompact,
  HlHistorySummary,
} from "@/lib/hl-builder-stats";
import { HlFrontendCard } from "@/components/hl-frontend-card";

/**
 * Responsive grid of `HlFrontendCard`, one per frontend in the compact
 * history blob. Client component so the sort selector is interactive
 * without a network round-trip.
 *
 * Sort modes:
 *   - `fees`  → last non-null fees value descending (default: matches
 *               the leaderboard's implicit ordering).
 *   - `peak`  → all-time max of the fees array, descending.
 *   - `age`   → first-active timestamp ascending (oldest first).
 *   - `volume`→ last non-null volume value descending.
 */

type SortBy = "fees" | "volume" | "peak" | "age";

export function HlFrontendGrid({
  history,
  sortBy: initialSortBy = "fees",
}: {
  history: HlHistorySummary;
  sortBy?: SortBy;
}) {
  const [sortBy, setSortBy] = useState<SortBy>(initialSortBy);

  const sorted = useMemo(
    () => sortFrontends(history.frontends, sortBy),
    [history.frontends, sortBy],
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-faint">
          {history.frontends.length} frontends · 12-month rolling 30d fees
        </p>
        <div className="inline-flex rounded-md border border-ink/15 text-[11px] overflow-hidden">
          <SortButton value="fees" current={sortBy} onSelect={setSortBy}>
            Fees now
          </SortButton>
          <SortButton value="volume" current={sortBy} onSelect={setSortBy}>
            Volume now
          </SortButton>
          <SortButton value="peak" current={sortBy} onSelect={setSortBy}>
            All-time peak
          </SortButton>
          <SortButton value="age" current={sortBy} onSelect={setSortBy}>
            Oldest first
          </SortButton>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {sorted.map((f, i) => (
          <HlFrontendCard
            key={f.slug}
            frontend={f}
            rank={i + 1}
            t0={history.t0}
            step={history.step}
          />
        ))}
      </div>
    </div>
  );
}

function SortButton({
  value,
  current,
  onSelect,
  children,
}: {
  value: SortBy;
  current: SortBy;
  onSelect: (v: SortBy) => void;
  children: React.ReactNode;
}) {
  const active = value === current;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`px-2.5 py-1.5 font-medium border-l border-ink/15 first:border-l-0 ${
        active
          ? "bg-ink text-paper"
          : "text-ink-soft hover:bg-paper-soft/60"
      }`}
    >
      {children}
    </button>
  );
}

function lastNonNull(arr: (number | null)[]): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return 0;
}

function peakOf(arr: (number | null)[]): number {
  let m = 0;
  for (const v of arr) {
    if (v !== null && v > m) m = v;
  }
  return m;
}

function sortFrontends(
  frontends: HlHistoryFrontendCompact[],
  by: SortBy,
): HlHistoryFrontendCompact[] {
  const copy = [...frontends];
  if (by === "fees") {
    copy.sort((a, b) => lastNonNull(b.fees) - lastNonNull(a.fees));
  } else if (by === "volume") {
    copy.sort((a, b) => lastNonNull(b.volume) - lastNonNull(a.volume));
  } else if (by === "peak") {
    copy.sort((a, b) => peakOf(b.fees) - peakOf(a.fees));
  } else if (by === "age") {
    copy.sort((a, b) => a.firstIdx - b.firstIdx);
  }
  return copy;
}
