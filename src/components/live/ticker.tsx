"use client";

import { memo } from "react";
import { LiveDot } from "@/components/live-dot";
import { fmtCount, fmtMoney } from "@/lib/live/format";
import type { GlobalView } from "@/lib/live/types";

/**
 * Single-row live ticker. Always visible at the top of the home page —
 * clicking the toggle reveals the streamed-volume chart + feed below.
 */
export const LiveTicker = memo(function LiveTicker({
  connected,
  stats,
  sessionSwaps,
  expanded,
  onToggle,
}: {
  connected: boolean;
  stats: GlobalView | null;
  sessionSwaps: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="card flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2 text-xs">
      <div className="flex items-center gap-2">
        {connected ? (
          <LiveDot className="h-2 w-2" />
        ) : (
          <span className="h-2 w-2 rounded-full bg-ink-faint" />
        )}
        <span
          className="label-mono"
          style={{ color: connected ? "var(--color-good)" : undefined }}
        >
          {connected ? "Live" : "Reconnecting"}
        </span>
      </div>

      <Stat label="Vol 24h" value={fmtMoney(stats?.vol24h)} />
      <Stat label="Txs 24h" value={fmtCount(stats?.trades24h)} />
      <Stat label="Mcap" value={fmtMoney(stats?.mcap)} />
      <Stat
        label="Streamed"
        value={sessionSwaps.toLocaleString()}
        accent={sessionSwaps > 0}
      />

      <button
        type="button"
        onClick={onToggle}
        className="ml-auto label-mono text-ink-muted hover:text-ink transition-colors"
      >
        {expanded ? "Collapse ▴" : "Expand ▾"}
      </button>
    </div>
  );
});

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5 min-w-0">
      <span className="label-mono text-ink-faint">{label}</span>
      <span
        className={`font-mono tabular text-[12px] ${
          accent ? "text-good" : "text-ink-soft"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
