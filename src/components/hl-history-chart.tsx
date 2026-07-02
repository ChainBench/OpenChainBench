"use client";

import { useMemo, useRef, useState } from "react";
import type {
  HlHistoryFrontend,
  HlHistoryPoint,
  HlHistorySummary,
} from "@/lib/hl-builder-stats";

/**
 * 12-month evolution chart for the top ~10 HL frontends. Two toggleable
 * metrics (fees / volume, both 30d rolling), one line per frontend.
 * Renders as a single SVG with a shared linear Y scale, so a viewer can
 * eyeball share-of-market swings without a legend hunt.
 *
 * Design goals:
 *   - Stays a single SVG. No recharts / D3. Data volume is ~10 × 365
 *     points, well inside SVG's cheap-to-render window.
 *   - Gaps: `v === null` points break the line rather than dropping to
 *     zero. Matches the harness' "no sample this UTC day" semantic and
 *     keeps early-history cohorts (post-launch) from starting from an
 *     artificial floor.
 *   - Colours: 10-slot OCB palette, cycled if the cohort ever grows past
 *     10. Hovered line lifts to full opacity; the rest dim.
 *   - Crosshair tooltip lists every frontend's value at the hovered
 *     timestamp, ranked by value so the top of the pack is always at
 *     eye level.
 */

const COLORS = [
  "#9d65ff", // violet
  "#ff8a3d", // orange
  "#22c55e", // emerald
  "#38bdf8", // sky
  "#f43f5e", // rose
  "#eab308", // amber
  "#14b8a6", // teal
  "#a855f7", // fuchsia
  "#f97316", // deep orange
  "#0ea5e9", // blue
];

type Metric = "fees" | "volume";

export function HlHistoryChart({ history }: { history: HlHistorySummary }) {
  const [metric, setMetric] = useState<Metric>("fees");
  const [pinnedSlug, setPinnedSlug] = useState<string | null>(null);

  const activeFrontends = history.frontends;
  if (activeFrontends.length === 0) {
    return (
      <p className="text-sm text-ink-faint italic">
        No history samples yet — the backfill is still populating.
      </p>
    );
  }

  return (
    <div
      className="rounded-xl border border-ink/10 p-4 sm:p-6"
      style={{
        background:
          "linear-gradient(180deg, rgba(157,101,255,0.04), rgba(157,101,255,0.01) 60%, transparent)",
        boxShadow:
          "0 1px 0 rgba(0,0,0,0.02), 0 8px 24px -16px rgba(60,40,110,0.16)",
      }}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="label-mono text-[10px] text-ink-faint">
            Last 12 months · rolling 30d
          </p>
          <p className="text-sm text-ink-faint mt-0.5">
            Daily-stepped snapshot of the top {activeFrontends.length} HL
            frontends
          </p>
        </div>
        <div className="inline-flex rounded-md border border-ink/15 text-[11px] overflow-hidden">
          <button
            type="button"
            onClick={() => setMetric("fees")}
            className={`px-3 py-1.5 font-medium ${
              metric === "fees"
                ? "bg-ink text-paper"
                : "text-ink-soft hover:bg-paper-soft/60"
            }`}
          >
            Fees 30d
          </button>
          <button
            type="button"
            onClick={() => setMetric("volume")}
            className={`px-3 py-1.5 font-medium border-l border-ink/15 ${
              metric === "volume"
                ? "bg-ink text-paper"
                : "text-ink-soft hover:bg-paper-soft/60"
            }`}
          >
            Volume 30d
          </button>
        </div>
      </div>

      <ChartCanvas
        frontends={activeFrontends}
        metric={metric}
        pinnedSlug={pinnedSlug}
      />

      <div className="mt-4 flex flex-wrap gap-2">
        {activeFrontends.map((f, i) => {
          const color = COLORS[i % COLORS.length];
          const pinned = pinnedSlug === f.slug;
          return (
            <button
              key={f.slug}
              type="button"
              onClick={() => setPinnedSlug(pinned ? null : f.slug)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-opacity ${
                pinnedSlug && !pinned
                  ? "border-ink/8 opacity-50"
                  : "border-ink/15"
              }`}
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: color }}
              />
              <span className="text-ink">{f.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChartCanvas({
  frontends,
  metric,
  pinnedSlug,
}: {
  frontends: HlHistoryFrontend[];
  metric: Metric;
  pinnedSlug: string | null;
}) {
  const W = 1100;
  const H = 360;
  const PAD_L = 68;
  const PAD_R = 20;
  const PAD_T = 20;
  const PAD_B = 44;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const seriesOf = (f: HlHistoryFrontend): HlHistoryPoint[] =>
    metric === "fees" ? f.fees30d : f.volume30d;

  // Shared time axis: derive from the longest series so a frontend that
  // launched mid-window still lines up on the shared calendar. The
  // fallback (used only when every frontend has an empty series) reads
  // the max `t` we can infer from the first non-empty series; if
  // everything is empty we degrade to a 0..1 span so the SVG still lays
  // out without pulling Date.now() inside a render-time hook.
  const tRange = useMemo(() => {
    let tMin = Number.POSITIVE_INFINITY;
    let tMax = Number.NEGATIVE_INFINITY;
    for (const f of frontends) {
      for (const p of seriesOf(f)) {
        if (p.t < tMin) tMin = p.t;
        if (p.t > tMax) tMax = p.t;
      }
    }
    if (!Number.isFinite(tMin) || !Number.isFinite(tMax) || tMin === tMax) {
      return { tMin: 0, tMax: 1 };
    }
    return { tMin, tMax };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frontends, metric]);

  const yMax = useMemo(() => {
    let m = 0;
    for (const f of frontends) {
      for (const p of seriesOf(f)) {
        if (p.v !== null && p.v > m) m = p.v;
      }
    }
    return niceMax(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frontends, metric]);

  const xFor = (t: number) => {
    const span = tRange.tMax - tRange.tMin || 1;
    return PAD_L + ((t - tRange.tMin) / span) * plotW;
  };
  const yFor = (v: number) =>
    PAD_T + plotH - (yMax > 0 ? (v / yMax) * plotH : 0);

  // Multi-segment path: break the line whenever we hit a null so the
  // chart shows gaps rather than a straight fall to zero + spike back.
  const pathFor = (f: HlHistoryFrontend): string => {
    const parts: string[] = [];
    let inSegment = false;
    for (const p of seriesOf(f)) {
      if (p.v === null) {
        inSegment = false;
        continue;
      }
      const cmd = inSegment ? "L" : "M";
      parts.push(`${cmd} ${xFor(p.t).toFixed(1)} ${yFor(p.v).toFixed(1)}`);
      inSegment = true;
    }
    return parts.join(" ");
  };

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const monthTicks = useMemo(
    () => buildMonthTicks(tRange.tMin, tRange.tMax),
    [tRange.tMin, tRange.tMax],
  );

  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);

  const onMove: React.PointerEventHandler<SVGSVGElement> = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const px = xRatio * W;
    if (px < PAD_L || px > W - PAD_R) {
      setHoverT(null);
      return;
    }
    const span = tRange.tMax - tRange.tMin;
    const t = tRange.tMin + ((px - PAD_L) / plotW) * span;
    setHoverT(t);
  };

  // Snap hover to nearest sample per frontend for the tooltip readout.
  const hoverRows = useMemo(() => {
    if (hoverT === null) return null;
    const rows: { slug: string; name: string; color: string; v: number | null }[] = [];
    for (let i = 0; i < frontends.length; i++) {
      const f = frontends[i];
      const s = seriesOf(f);
      if (s.length === 0) {
        rows.push({ slug: f.slug, name: f.name, color: COLORS[i % COLORS.length], v: null });
        continue;
      }
      let best = s[0];
      let bestDist = Math.abs(best.t - hoverT);
      for (const p of s) {
        const d = Math.abs(p.t - hoverT);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      rows.push({
        slug: f.slug,
        name: f.name,
        color: COLORS[i % COLORS.length],
        v: best.v,
      });
    }
    rows.sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverT, frontends, metric]);

  const hoverX = hoverT !== null ? xFor(hoverT) : null;
  const hoverDate = hoverT !== null ? formatDate(hoverT) : null;

  return (
    <div className="relative w-full overflow-hidden">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full h-[320px] sm:h-[360px]"
        preserveAspectRatio="none"
        onPointerMove={onMove}
        onPointerLeave={() => setHoverT(null)}
      >
        {ticks.map((t) => {
          const y = PAD_T + plotH * (1 - t);
          const v = yMax * t;
          return (
            <g key={t}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y}
                y2={y}
                stroke="currentColor"
                className="text-ink/8"
                strokeWidth={1}
                strokeDasharray={t === 0 ? "0" : "2 4"}
              />
              <text
                x={PAD_L - 8}
                y={y + 3}
                textAnchor="end"
                style={{ fontFamily: "var(--font-mono, monospace)" }}
                className="fill-ink-faint text-[10px] tabular-nums"
              >
                {fmtUSDShort(v)}
              </text>
            </g>
          );
        })}

        {monthTicks.map((mt) => {
          const x = xFor(mt.t);
          if (x < PAD_L - 1 || x > W - PAD_R + 1) return null;
          return (
            <g key={mt.t}>
              <line
                x1={x}
                x2={x}
                y1={PAD_T + plotH}
                y2={PAD_T + plotH + 4}
                stroke="currentColor"
                className="text-ink/20"
                strokeWidth={1}
              />
              <text
                x={x}
                y={H - PAD_B + 18}
                textAnchor="middle"
                style={{ fontFamily: "var(--font-mono, monospace)" }}
                className="fill-ink-faint text-[10px] tabular-nums"
              >
                {mt.label}
              </text>
            </g>
          );
        })}

        {frontends.map((f, i) => {
          const color = COLORS[i % COLORS.length];
          const dimmed = pinnedSlug !== null && pinnedSlug !== f.slug;
          return (
            <path
              key={f.slug}
              d={pathFor(f)}
              fill="none"
              stroke={color}
              strokeWidth={pinnedSlug === f.slug ? 2.4 : 1.6}
              strokeOpacity={dimmed ? 0.15 : 0.9}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transition: "stroke-opacity 120ms ease-out" }}
            />
          );
        })}

        {hoverX !== null && (
          <line
            x1={hoverX}
            x2={hoverX}
            y1={PAD_T}
            y2={PAD_T + plotH}
            stroke="currentColor"
            className="text-ink/25"
            strokeWidth={1}
            strokeDasharray="2 2"
          />
        )}
      </svg>

      {hoverRows && hoverDate && hoverX !== null && (
        <Tooltip
          rows={hoverRows}
          date={hoverDate}
          xFrac={hoverX / W}
        />
      )}
    </div>
  );
}

function Tooltip({
  rows,
  date,
  xFrac,
}: {
  rows: { slug: string; name: string; color: string; v: number | null }[];
  date: string;
  xFrac: number;
}) {
  const left = Math.max(4, Math.min(96, xFrac * 100));
  const flipX = left > 55;
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-lg border border-ink/15 bg-paper shadow-lg px-3 py-2 text-[11.5px]"
      style={{
        left: `${left}%`,
        top: 8,
        transform: `translateX(${flipX ? "-100%" : "0%"}) translateX(${flipX ? -8 : 8}px)`,
        minWidth: 200,
      }}
    >
      <p
        className="label-mono text-[10px] text-ink-faint mb-1"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {date}
      </p>
      <div className="grid grid-cols-1 gap-0.5">
        {rows.slice(0, 10).map((r) => (
          <div key={r.slug} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 truncate">
              <span
                className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                style={{ background: r.color }}
              />
              <span className="text-ink truncate">{r.name}</span>
            </span>
            <span className="font-semibold tabular-nums">
              {r.v === null ? "—" : fmtUSDShort(r.v)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  if (f <= 1) return exp;
  if (f <= 2) return 2 * exp;
  if (f <= 5) return 5 * exp;
  return 10 * exp;
}

function fmtUSDShort(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function formatDate(t: number): string {
  const d = new Date(t);
  return d.toISOString().slice(0, 10);
}

/** First-of-month labels between two epoch-ms bounds. Keeps the count
 *  bounded (~12 labels) so the axis never crowds. */
function buildMonthTicks(
  tMinMs: number,
  tMaxMs: number,
): { t: number; label: string }[] {
  const out: { t: number; label: string }[] = [];
  const start = new Date(tMinMs);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const MONTH_NAMES = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  while (cursor.getTime() <= tMaxMs) {
    const t = cursor.getTime();
    if (t >= tMinMs) {
      const label =
        cursor.getUTCMonth() === 0
          ? `${MONTH_NAMES[0]} ${cursor.getUTCFullYear() % 100}`
          : MONTH_NAMES[cursor.getUTCMonth()];
      out.push({ t, label });
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}
