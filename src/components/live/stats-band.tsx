"use client";

import { memo, useMemo } from "react";
import { fmtCount, fmtMoney } from "@/lib/live/format";
import type { GlobalView } from "@/lib/live/types";

type Props = {
  stats: GlobalView | null;
  sessionSwaps: number;
  sessionVol: number;
  feedOpen: boolean;
  onToggleFeed: () => void;
};

export const StatsBand = memo(function StatsBand({
  stats,
  sessionSwaps,
  sessionVol,
  feedOpen,
  onToggleFeed,
}: Props) {
  // Memoise the sub-line strings — they only depend on numeric props.
  const txsSub = useMemo(
    () =>
      stats
        ? `${fmtCount(stats.buys24h)} buys · ${fmtCount(stats.sells24h)} sells`
        : "All chains",
    [stats],
  );

  const streamedSub = useMemo(
    () => (sessionVol > 0 ? `${fmtMoney(sessionVol)} streamed` : "This session"),
    [sessionVol],
  );

  return (
    <div className="card grid grid-cols-2 sm:grid-cols-4 gap-px bg-rule overflow-hidden">
      <Tile label="Vol 24h" value={fmtMoney(stats?.vol24h)} sub="All chains · DEX trades" />
      <Tile label="Txs 24h" value={fmtCount(stats?.trades24h)} sub={txsSub} />
      <Tile label="Market Cap" value={fmtMoney(stats?.mcap)} sub="All tracked assets" />
      <Tile
        label="Streamed live"
        value={sessionSwaps.toLocaleString()}
        sub={streamedSub}
        emphasize
        onClick={onToggleFeed}
        action={feedOpen ? "Hide feed ▾" : "View feed ▸"}
      />
    </div>
  );
});

function Tile({
  label,
  value,
  sub,
  emphasize,
  onClick,
  action,
}: {
  label: string;
  value: string;
  sub: string;
  emphasize?: boolean;
  onClick?: () => void;
  action?: string;
}) {
  const Wrapper = onClick ? "button" : "div";
  const interactiveClass = onClick
    ? "cursor-pointer hover:bg-paper-soft transition-colors text-left"
    : "";
  return (
    <Wrapper
      onClick={onClick}
      type={onClick ? "button" : undefined}
      className={`relative flex flex-col gap-3 px-5 py-6 bg-surface min-w-0 ${interactiveClass}`}
    >
      <p className="label-mono text-ink-muted truncate">{label}</p>
      <p
        className={`display-num leading-none tabular truncate ${
          emphasize ? "text-3xl sm:text-4xl text-good" : "text-3xl sm:text-4xl text-ink"
        }`}
      >
        {value}
      </p>
      <p className="text-[11px] text-ink-muted leading-snug truncate">
        {sub}
        {action && <span className="ml-2 label-mono text-ink-faint">{action}</span>}
      </p>
    </Wrapper>
  );
}
