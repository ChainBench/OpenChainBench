"use client";

import { memo } from "react";
import { LiveDot } from "@/components/live-dot";
import { fmtCount, fmtMoney } from "@/lib/live/format";
import type { GlobalView } from "@/lib/live/types";

/**
 * Compact one-line live ticker — the collapsed state of LiveDashboard.
 * Keeps the "ça stream" signal + headline numbers visible without
 * eating ~250px of vertical space above the benchmark table.
 */
export const LiveTicker = memo(function LiveTicker({
  connected,
  stats,
  sessionSwaps,
  onExpand,
}: {
  connected: boolean;
  stats: GlobalView | null;
  sessionSwaps: number;
  onExpand: () => void;
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
        onClick={onExpand}
        className="ml-auto label-mono text-ink-muted hover:text-ink transition-colors"
      >
        Expand ▾
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
