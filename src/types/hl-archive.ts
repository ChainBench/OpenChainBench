/**
 * Shared wire types for the Hyperliquid long-window archive layer.
 *
 * The archive is written by an out-of-process Go service (hl-archive) that
 * tails the local hl-node fill stream, aggregates per-builder windows the
 * Prom snapshot can't hold (90d, 180d, 1y, all-time), and parks the result
 * in Upstash for the OpenChainBench Next.js app to read on demand.
 *
 * Wire shape is documented here so the Go side and the Next.js readers
 * never drift: any field addition is a v2 of the Upstash key.
 */

export type HlArchiveWindow =
  | "24h"
  | "7d"
  | "30d"
  | "90d"
  | "180d"
  | "1y"
  | "all";

/** Long-window subset used by the API and the UI toggle for the windows
 *  the Prom snapshot cannot serve. Live windows (24h/7d/30d) flow through
 *  the existing Benchmark snapshot. */
export type HlArchiveLongWindow = "90d" | "180d" | "1y" | "all";

export const HL_ARCHIVE_LONG_WINDOWS: readonly HlArchiveLongWindow[] = [
  "90d",
  "180d",
  "1y",
  "all",
] as const;

export const HL_ARCHIVE_WINDOWS: readonly HlArchiveWindow[] = [
  "24h",
  "7d",
  "30d",
  ...HL_ARCHIVE_LONG_WINDOWS,
] as const;

export type HlArchiveWindowTotals = {
  volume_usd: number;
  fees_usd: number;
  fills: number;
  /** Sum of daily distinct users over the window (user-days). Not the
   *  true across-days unique-users because the archive DuckDB does not
   *  retain per-day user sets — only cardinalities — to keep storage
   *  bounded. Absent on responses served by an older harness build. */
  users?: number;
};

export type HlArchiveDailyPoint = {
  day: string;
  vol: number;
  fees: number;
  fills: number;
  /** Distinct user addresses seen at (day, builder). A user who traded
   *  multiple assets that day counts once. Absent on responses served
   *  by an older harness build. */
  users?: number;
};

export type HlArchiveBuilder = {
  /** OCB provider slug (e.g. "phantom-perps"). Emitted by hl-archive from
   *  its builders.json registry so the frontend can look up a builder
   *  without maintaining its own address→slug map. Empty when the
   *  registry entry has no slug set (should never happen in prod). */
  slug: string;
  name: string;
  windows: Partial<Record<HlArchiveWindow, HlArchiveWindowTotals>>;
  timeseries_daily?: HlArchiveDailyPoint[];
};

export type ArchiveSnapshot = {
  updated_at: string;
  builders: Record<string, HlArchiveBuilder>;
};

/** Ranked, leaderboard-ready row emitted by the history API. Stable shape
 *  shared with the client so the UI can render archive rows and live
 *  Prom-derived rows from a single component. */
export type HlArchiveRankedRow = {
  slug: string;
  name: string;
  volume_usd: number;
  fees_usd: number;
  fills: number;
  /** Distinct-user rollup for the row's window. Same semantic as
   *  HlArchiveWindowTotals.users (user-days for long windows, absent
   *  for Prom-sourced short windows because the live snapshot does
   *  not carry a users signal today). */
  users?: number;
  rank: number;
};

export type HlArchiveHistoryResponse = {
  window: HlArchiveWindow;
  source: "prom" | "archive";
  updated_at: string;
  rows: HlArchiveRankedRow[];
  /** Per-builder daily timeseries for the selected window, keyed by the
   *  same slug used in `rows[]`. Only emitted on archive-sourced
   *  responses (long windows: 90d/180d/1y/all). Powers the time-series
   *  chart when the reader selects a long window. */
  timeseries_daily?: Record<string, HlArchiveDailyPoint[]>;
};
