"use client";

import { memo } from "react";
import { LiveDot } from "@/components/live-dot";
import { LiveNumber } from "@/components/live/live-number";
import { fmtCountFull, fmtMoneyFull } from "@/lib/live/format";
import type { GlobalView } from "@/lib/live/types";

/**
 * Single-row live ticker. Always visible at the top of the home page -
 * clicking the toggle reveals the streamed-volume chart + feed below.
 *
 * Numbers are shown in full (commas, every digit visible) and tick
 * between relay snapshots via LiveNumber, so the rolling 24h counters
 * feel alive instead of refreshing in once-per-second steps.
 *
 * Data sources (Mobula REST, polled by miniapps/ocb-stream-relay):
 *   • vol24h   - sum of trading volume across all chains/DEXes (lighthouse)
 *   • trades24h - total swap count over the last 24h (lighthouse)
 *   • mcap     - sum of market_cap from /api/1/all = total crypto market cap
 */
export const LiveTicker = memo(function LiveTicker({
  connected,
  stats,
  expanded,
  onToggle,
}: {
  connected: boolean;
  stats: GlobalView | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="card flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-x-6 gap-y-2 px-4 py-2.5 text-xs">
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

      <Stat
        label="Onchain volume · 24h"
        value={stats?.vol24h}
        format={fmtMoneyFull}
        monotonic
      />
      <Stat
        label="Onchain txs · 24h"
        value={stats?.trades24h}
        format={fmtCountFull}
        monotonic
      />
      <Stat
        label="Total crypto mcap"
        value={stats?.mcap}
        format={fmtMoneyFull}
      />

      <button
        type="button"
        onClick={onToggle}
        className="self-end sm:self-auto sm:ml-auto label-mono text-ink-muted hover:text-ink transition-colors min-h-[32px]"
      >
        {expanded ? "Collapse ▴" : "Expand ▾"}
      </button>
    </div>
  );
});

function Stat({
  label,
  value,
  format,
  monotonic,
}: {
  label: string;
  value: number | undefined;
  format: (n: number | undefined) => string;
  monotonic?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="label-mono text-ink-faint shrink-0">{label}</span>
      <LiveNumber
        value={value}
        format={format}
        monotonic={monotonic}
        className="font-sans tabular text-[12px] text-ink-soft"
      />
    </div>
  );
}
