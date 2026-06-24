"use client";

import Link from "next/link";

/**
 * Row of cards, one per perp benchmark, showing how the current venue
 * stacks against the cohort: rank, value, and a compact display (the
 * dedicated bench page carries the heavier chart).
 *
 * Hover surfaces the methodology + a "view full leaderboard" link. The
 * data is passed in by the server-rendered section wrapper. Cards with
 * null value or null rank do not render (PerpVenueSection filters those
 * out before calling).
 */

export type PerpVenueBenchRow = {
  /** Bench id used in URLs (e.g. "perp-fees"). */
  benchSlug: string;
  /** Display name shown on the card. */
  label: string;
  /** Short one-liner explaining what the bench measures. */
  blurb: string;
  /** Cohort rank for this venue, 1-indexed. null if not measured. */
  rank: number | null;
  /** Total cohort size, for "N of M" rendering. */
  cohortSize: number;
  /** Measured value rendered as headline (formatted). */
  value: string | null;
  /** Delta vs cohort median for an at-a-glance read. e.g. "1.4x median". */
  vsMedian: string | null;
  /** Color accent tone. */
  tone?: "teal" | "cyan" | "indigo" | "violet";
};

const TONES: Record<NonNullable<PerpVenueBenchRow["tone"]>, string> = {
  teal: "#14b8a6",
  cyan: "#06b6d4",
  indigo: "#6366f1",
  violet: "#8b5cf6",
};

export function PerpVenueBenchCards({ rows }: { rows: PerpVenueBenchRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {rows.map((r) => (
        <BenchCard key={r.benchSlug} row={r} />
      ))}
    </div>
  );
}

function BenchCard({ row }: { row: PerpVenueBenchRow }) {
  const accent = TONES[row.tone ?? "teal"];
  const measured = row.value !== null && row.rank !== null;
  return (
    <Link
      href={`/benchmarks/${row.benchSlug}`}
      className="block card-soft rounded-lg p-3 sm:p-4 border border-ink/10 hover:border-ink/25 transition-colors"
      title={row.blurb}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <span
          className="label-mono text-[10px] text-ink-faint uppercase tracking-wide"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {row.label}
        </span>
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ background: accent }}
          aria-hidden
        />
      </div>

      {measured ? (
        <>
          <p className="text-lg sm:text-xl font-semibold tabular-nums leading-tight">
            {row.value}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-faint tabular-nums">
            Rank {row.rank} of {row.cohortSize}
            {row.vsMedian ? ` · ${row.vsMedian}` : ""}
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-ink-faint italic leading-tight">
            Not measured yet
          </p>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            View bench methodology
          </p>
        </>
      )}
    </Link>
  );
}
