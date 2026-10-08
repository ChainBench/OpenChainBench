"use client";

import { useState } from "react";
import { HL_WINDOWS, HL_WINDOW_LABEL } from "@/lib/hl-feed";
import type { HlWindow } from "@/lib/hl-feed";
import type { HlBuilderStats } from "@/lib/hl-builder-stats";

/**
 * The headline figures for one Hyperliquid frontend, with a control for the
 * window they cover.
 *
 * The strip was fixed at 30 days, which is the complaint that started this:
 * a reader who wants to know what a frontend did yesterday had no way to ask.
 * The harness has published 24h, 7d and 30d for revenue, volume, users and
 * the period-over-period delta all along; only the page was pinned.
 *
 * Two of the six cards do not move with the control, and say so rather than
 * silently reusing a 30d number under a "feed day" heading:
 *
 *  - Annualised is the window's revenue scaled to a year, so it is derived
 *    from the window and changes, but its multiplier changes with it.
 *  - Cohort share is defined as a share of the cohort's 24h notional. There
 *    is no 7d or 30d version of it in the harness, and computing one here
 *    from figures that are not published would be inventing a number.
 */

/** Days each window spans, for the annualised projection. "24h" is one
 *  complete UTC feed day. */
const WINDOW_DAYS: Record<HlWindow, number> = { "24h": 1, "7d": 7, "30d": 30 };

export function HlKpiStrip({ stats }: { stats: HlBuilderStats }) {
  const [timeframe, setTimeframe] = useState<HlWindow>("30d");

  // A stats object cached before byWindow existed would otherwise render a
  // strip of zeros for one cache cycle.
  const w = stats.byWindow?.[timeframe] ?? {
    revenue: stats.revenue30d,
    volume: stats.volume30d,
    users: stats.users30d,
    revenueDelta: stats.revenueDelta30d,
  };

  const label = HL_WINDOW_LABEL[timeframe];
  const days = WINDOW_DAYS[timeframe];
  const perUser = w.users > 0 ? w.revenue / w.users : 0;

  return (
    <>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <p className="label-mono text-ink-faint">
          Hyperliquid frontend dashboard
        </p>
        <div
          className="inline-flex rounded-md border border-ink/15 overflow-hidden"
          role="group"
          aria-label="Timeframe"
        >
          {HL_WINDOWS.map((win) => (
            <button
              key={win}
              type="button"
              onClick={() => setTimeframe(win)}
              aria-pressed={timeframe === win}
              className={
                "px-2.5 py-1 text-[11px] tabular-nums transition-colors " +
                (timeframe === win
                  ? "bg-ink text-paper"
                  : "text-ink-soft hover:bg-paper-soft/60")
              }
            >
              {HL_WINDOW_LABEL[win]}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard
          label={`Revenue ${label}`}
          value={fmtUSD(w.revenue)}
          delta={w.revenueDelta}
          tone="primary"
        />
        <KpiCard
          label={`Volume ${label}`}
          value={fmtUSD(w.volume)}
          tone="primary"
        />
        <KpiCard
          label={`Users ${label}`}
          value={fmtCount(w.users)}
          tone="primary"
          tip={
            timeframe === "24h"
              ? "Distinct wallets on the last complete UTC feed day."
              : `Distinct wallets over ${days} days. A union of the daily sets, never a sum, so a wallet active every day counts once.`
          }
        />
        <KpiCard label={`$ / user ${label}`} value={fmtUSD(perUser)} />
        <KpiCard
          label="Annualised"
          value={fmtUSD(w.revenue * (365 / days))}
          tip={`Projection: ${label} revenue x 365/${days}`}
        />
        <KpiCard
          label="% cohort 24h vol"
          value={fmtPct(stats.cohortVolumeShare24h)}
          tip="Share of the tracked builders' 24h notional volume. Always 24h: the harness publishes no 7d or 30d cohort share, and deriving one here would be inventing it."
        />
      </div>
    </>
  );
}

function KpiCard({
  label,
  value,
  delta,
  tip,
  tone,
}: {
  label: string;
  value: string;
  delta?: number;
  tip?: string;
  tone?: "primary";
}) {
  const arrowTone =
    delta === undefined
      ? ""
      : delta > 0
        ? "text-emerald-600 dark:text-emerald-400"
        : delta < 0
          ? "text-red-600 dark:text-red-400"
          : "text-ink-faint";
  return (
    <div
      className={
        "card-soft rounded-lg p-3 sm:p-4 " +
        (tone === "primary" ? "border border-ink/15" : "border border-ink/8")
      }
      title={tip}
    >
      <p className="label-mono text-[10px] text-ink-faint mb-1">{label}</p>
      <p className="text-lg sm:text-xl font-semibold tabular-nums leading-tight">
        {value}
      </p>
      {delta !== undefined && (
        <p className={`mt-0.5 text-xs ${arrowTone}`}>{fmtDelta(delta)}</p>
      )}
    </div>
  );
}

function fmtUSD(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

function fmtCount(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}

function fmtPct(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0%";
  const pct = v * 100;
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(3)}%`;
}

function fmtDelta(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0%";
  const pct = v * 100;
  const sign = v > 0 ? "+" : "";
  if (Math.abs(pct) >= 10) return `${sign}${pct.toFixed(0)}%`;
  return `${sign}${pct.toFixed(1)}%`;
}
