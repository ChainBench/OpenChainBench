import Link from "next/link";
import type { HlHistoryFrontendCompact } from "@/lib/hl-builder-stats";

/**
 * Compact per-frontend card for the `/hyperliquid` grid overview. Displays
 * a single-metric log-scale sparkline over the last 12 months plus the
 * current rolling-30d fees KPI, a 30-day delta and the frontend's first
 * active day. Whole card is a `<Link>` to `/hyperliquid/[slug]` so the
 * detail page is one click away.
 *
 * The parent chart (`HlHistoryChart`) uses log10(v+1) on Y; we mirror that
 * here so a $200 frontend and a $5M frontend both get readable sparkline
 * shapes at 200x40px.
 */

type Props = {
  frontend: HlHistoryFrontendCompact;
  rank: number;
  /** t0 (ms) from the parent envelope, needed to render the "since" label. */
  t0: number;
  /** step (seconds) from the parent envelope. */
  step: number;
};

export function HlFrontendCard({ frontend, rank, t0, step }: Props) {
  const { slug, name, fees, firstIdx } = frontend;

  // Last non-null fees value = current KPI. Walk from the end so a trailing
  // null (harness gap on the freshest UTC day) doesn't blank the card.
  let currentFees: number | null = null;
  let currentIdx = -1;
  for (let i = fees.length - 1; i >= 0; i--) {
    const v = fees[i];
    if (v !== null && Number.isFinite(v)) {
      currentFees = v;
      currentIdx = i;
      break;
    }
  }

  // 30-day delta: current vs the value 30 samples earlier in the local
  // array. `firstIdx` is already dropped from the array, so we don't need
  // to re-offset. Skip if we don't have 30 days of history.
  let delta30d: number | null = null;
  if (currentFees !== null && currentFees > 0 && currentIdx >= 30) {
    const prev = fees[currentIdx - 30];
    if (prev !== null && Number.isFinite(prev) && prev > 0) {
      delta30d = (currentFees - prev) / prev;
    }
  }

  const firstDayMs = t0 + step * 1000 * firstIdx;
  const sinceLabel = formatSince(firstDayMs);

  return (
    <Link
      href={`/hyperliquid/${slug}`}
      className="group flex flex-col rounded-lg border border-ink/10 bg-paper p-3 transition-colors hover:border-ink/30 hover:bg-paper-soft/40"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{name}</p>
          <p
            className="truncate text-[10px] text-ink-faint"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {slug}
          </p>
        </div>
        <span
          className="shrink-0 rounded-full border border-ink/10 bg-paper-soft px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-ink-faint"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          #{rank}
        </span>
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-lg font-semibold tabular-nums text-ink">
          {currentFees !== null ? fmtUSDShort(currentFees) : "—"}
        </span>
        {delta30d !== null && (
          <span
            className="text-[11px] font-medium tabular-nums"
            style={{
              color: delta30d >= 0 ? "var(--color-good)" : "var(--color-bad)",
            }}
          >
            {fmtDelta(delta30d)}
          </span>
        )}
      </div>
      <p
        className="label-mono mt-0.5 text-[10px] text-ink-faint"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        Fees 30d
      </p>

      <Sparkline values={fees} />

      <p className="mt-2 text-[10px] text-ink-faint">since {sinceLabel}</p>
    </Link>
  );
}

/** Log-scale sparkline mirroring HlHistoryChart's Y transform. Null values
 *  break the path so gaps render as gaps rather than dropping to zero. */
function Sparkline({ values }: { values: (number | null)[] }) {
  const W = 200;
  const H = 40;
  const PAD = 2;
  const plotW = W - PAD * 2;
  const plotH = H - PAD * 2;

  if (values.length === 0) {
    return <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 block h-10 w-full" />;
  }

  let vMax = 0;
  for (const v of values) {
    if (v !== null && v > vMax) vMax = v;
  }
  const logMax = Math.log10(vMax + 1);
  const logDen = logMax || 1;

  const n = values.length;
  const xFor = (i: number) => PAD + (n === 1 ? 0 : (i / (n - 1)) * plotW);
  const yFor = (v: number) => {
    const clamped = v > 0 ? v : 0;
    const norm = Math.log10(clamped + 1) / logDen;
    return PAD + plotH * (1 - norm);
  };

  const parts: string[] = [];
  let inSeg = false;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null) {
      inSeg = false;
      continue;
    }
    const cmd = inSeg ? "L" : "M";
    parts.push(`${cmd} ${xFor(i).toFixed(1)} ${yFor(v).toFixed(1)}`);
    inSeg = true;
  }
  const path = parts.join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="mt-2 block h-10 w-full"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d={path}
        fill="none"
        stroke="#9d65ff"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="transition-opacity group-hover:opacity-100"
        style={{ opacity: 0.85 }}
      />
    </svg>
  );
}

function fmtUSDShort(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtDelta(d: number): string {
  const pct = d * 100;
  const sign = pct >= 0 ? "+" : "";
  if (Math.abs(pct) >= 1000) return `${sign}${pct.toFixed(0)}%`;
  if (Math.abs(pct) >= 100) return `${sign}${pct.toFixed(0)}%`;
  return `${sign}${pct.toFixed(1)}%`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatSince(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
