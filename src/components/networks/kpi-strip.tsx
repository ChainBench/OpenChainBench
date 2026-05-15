"use client";

import { ChevronDown } from "lucide-react";
import { LiveNumber } from "@/components/live/live-number";
import { fmtCount, fmtMoney } from "@/lib/live/format";
import type { GlobalView } from "@/lib/live/types";

/**
 * Four-card horizontal KPI strip across the top of /networks. Visual
 * grid uses `gap-px bg-rule` so the cell dividers are 1 px slate lines
 * and each card occupies one cell with white fill — matches Screenshot 3.
 */
export function KpiStrip({
  stats,
  streamedCount,
  streamedUsd,
  recent10sCount,
  feedHidden,
  onToggleFeed,
}: {
  stats: GlobalView | null;
  streamedCount: number;
  streamedUsd: number;
  recent10sCount: number;
  feedHidden: boolean;
  onToggleFeed: () => void;
}) {
  const buys = stats?.buys24h;
  const sells = stats?.sells24h;
  const buysSellsHint =
    buys != null && sells != null
      ? `${fmtCount(buys)} buys · ${fmtCount(sells)} sells`
      : "Tracking buy/sell split";

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-rule rounded-xl border border-rule overflow-hidden">
      <KpiCell label="Vol 24h" hint="All chains · DEX trades">
        <BigNumber value={stats?.vol24h} format={fmtMoney} monotonic />
      </KpiCell>

      <KpiCell label="Txs 24h" hint={buysSellsHint}>
        <BigNumber value={stats?.trades24h} format={fmtCount} monotonic />
      </KpiCell>

      <KpiCell label="Market cap" hint="All tracked assets">
        <BigNumber value={stats?.mcap} format={fmtMoney} />
      </KpiCell>

      <KpiCell
        label="Streamed live"
        hint={`${fmtMoney(streamedUsd)} updates since load`}
        topRight={
          recent10sCount > 0 ? (
            <span className="bg-good/10 text-good text-xs px-1.5 py-0.5 rounded font-mono tabular">
              +{recent10sCount}
            </span>
          ) : null
        }
        bottomRight={
          <button
            type="button"
            onClick={onToggleFeed}
            className="label-mono text-ink-muted hover:text-ink transition-colors inline-flex items-center gap-1"
          >
            {feedHidden ? "Show feed" : "Hide feed"}
            <ChevronDown
              size={11}
              strokeWidth={2.2}
              className={`text-ink-faint transition-transform ${feedHidden ? "rotate-180" : ""}`}
            />
          </button>
        }
      >
        <BigNumber value={streamedCount} format={(n) => (n == null ? "—" : n.toLocaleString())} monotonic />
      </KpiCell>
    </div>
  );
}

function KpiCell({
  label,
  hint,
  topRight,
  bottomRight,
  children,
}: {
  label: string;
  hint: string;
  topRight?: React.ReactNode;
  bottomRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-paper p-6 flex flex-col gap-3 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <span className="label-mono text-ink-muted">{label}</span>
        {topRight}
      </div>
      <div className="text-3xl sm:text-4xl display-num text-ink leading-none tabular">
        {children}
      </div>
      <div className="flex items-end justify-between gap-2 mt-auto">
        <span className="text-xs text-ink-muted truncate">{hint}</span>
        {bottomRight}
      </div>
    </div>
  );
}

function BigNumber({
  value,
  format,
  monotonic,
}: {
  value: number | undefined;
  format: (n: number | undefined) => string;
  monotonic?: boolean;
}) {
  return <LiveNumber value={value} format={format} monotonic={monotonic} className="" />;
}
