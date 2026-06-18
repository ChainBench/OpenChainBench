"use client";

import { useMemo, useRef, useState } from "react";
import type { ChainTvlHistory } from "@/lib/chain-kpis";

/**
 * Interactive TVL chart for /chains/[slug]. Full DefiLlama history is
 * fetched server-side once (full series ~50 KB) and sliced client-side
 * by the active range pill (7D / 30D / 90D / 1Y / All).
 *
 * Hover surfaces a crosshair + tooltip with the exact value at that
 * date. Crosshair is pointer-event-driven so it works on desktop
 * (mouse) and touch (drag); the tooltip clamps to the chart edges so
 * it never runs off-canvas.
 *
 * The area gradient and stroke colour mirror the period delta:
 * green when current > range-start, red otherwise. Mirrors the
 * convention used on every other live ticker on the site.
 */

type Range = "7D" | "30D" | "90D" | "1Y" | "All";
const RANGES: Range[] = ["7D", "30D", "90D", "1Y", "All"];
const RANGE_DAYS: Record<Range, number | null> = {
  "7D": 7,
  "30D": 30,
  "90D": 90,
  "1Y": 365,
  All: null,
};

export function ChainTvlChart({
  history,
  chainLabel,
}: {
  history: ChainTvlHistory;
  chainLabel: string;
}) {
  const [range, setRange] = useState<Range>("30D");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Pointer-driven crosshair. We snap to the nearest data index so the
  // tooltip never shows an interpolated value.
  const svgRef = useRef<SVGSVGElement>(null);

  const points = useMemo(() => {
    const days = RANGE_DAYS[range];
    return days != null ? history.points.slice(-days) : history.points;
  }, [history.points, range]);

  if (points.length < 2) return null;

  const W = 1100;
  const H = 260;
  const PAD_L = 64;
  const PAD_R = 24;
  const PAD_T = 16;
  const PAD_B = 36;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const vals = points.map((p) => p.tvl);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const span = Math.max(1, maxV - minV);
  // Pad the y-axis a touch so the line never glues to the top/bottom edges.
  const yMin = minV - span * 0.06;
  const yMax = maxV + span * 0.06;
  const ySpan = Math.max(1, yMax - yMin);

  const n = points.length;
  const xFor = (i: number) => PAD_L + (plotW * i) / Math.max(1, n - 1);
  const yFor = (v: number) => PAD_T + plotH - ((v - yMin) / ySpan) * plotH;

  const linePath = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yFor(p.tvl).toFixed(1)}`,
    )
    .join(" ");
  const areaPath = `${linePath} L ${xFor(n - 1).toFixed(1)} ${(PAD_T + plotH).toFixed(1)} L ${xFor(0).toFixed(1)} ${(PAD_T + plotH).toFixed(1)} Z`;

  const first = points[0];
  const last = points[points.length - 1];
  const deltaPct = first.tvl > 0 ? ((last.tvl - first.tvl) / first.tvl) * 100 : 0;
  const isUp = deltaPct >= 0;
  const lineColor = isUp ? "#10b981" : "#ef4444";
  const deltaTone = isUp
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-red-600 dark:text-red-400";

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => yMin + ySpan * t);

  const onMove: React.PointerEventHandler<SVGSVGElement> = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const px = xRatio * W;
    if (px < PAD_L || px > W - PAD_R) {
      setHoverIdx(null);
      return;
    }
    const i = Math.round(((px - PAD_L) / plotW) * (n - 1));
    setHoverIdx(Math.min(n - 1, Math.max(0, i)));
  };

  const hover = hoverIdx != null ? points[hoverIdx] : null;

  return (
    <div className="mt-6 rounded-xl border border-ink/10 bg-paper-soft/30 p-4 sm:p-5">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
        <div>
          <p
            className="label-mono text-[10px] text-ink-faint"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {chainLabel} TVL · {range === "All" ? "all time" : `last ${range}`}
          </p>
          <p className="text-sm text-ink-faint mt-0.5">
            {fmtUSD(last.tvl)}{" "}
            <span className={`font-semibold tabular-nums ml-1 ${deltaTone}`}>
              {isUp ? "+" : ""}
              {deltaPct.toFixed(1)}%
            </span>
          </p>
        </div>
        <div
          className="inline-flex rounded-lg border border-ink/15 p-1 bg-paper-soft/40"
          role="tablist"
          aria-label="TVL range selector"
        >
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={r === range}
              onClick={() => setRange(r)}
              className={`px-3 py-1 rounded-md text-[12px] font-medium transition-colors ${
                r === range
                  ? "bg-paper text-ink shadow-sm"
                  : "text-ink-soft hover:text-ink"
              }`}
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="relative w-full overflow-hidden">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-[220px] sm:h-[260px] block"
          preserveAspectRatio="none"
          onPointerMove={onMove}
          onPointerLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id="chain-tvl-area-bg" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity={0.22} />
              <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
            </linearGradient>
          </defs>

          {ticks.map((tv) => {
            const y = yFor(tv);
            return (
              <g key={tv}>
                <line
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  className="text-ink/8"
                  strokeWidth={1}
                  strokeDasharray="2 4"
                />
                <text
                  x={PAD_L - 8}
                  y={y + 3}
                  textAnchor="end"
                  style={{ fontFamily: "var(--font-mono, monospace)" }}
                  className="fill-ink-faint text-[10px] tabular-nums"
                >
                  {fmtUSDShort(tv)}
                </text>
              </g>
            );
          })}

          <path d={areaPath} fill="url(#chain-tvl-area-bg)" />
          <path
            d={linePath}
            fill="none"
            stroke={lineColor}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {hover && hoverIdx != null && (
            <g>
              <line
                x1={xFor(hoverIdx)}
                x2={xFor(hoverIdx)}
                y1={PAD_T}
                y2={PAD_T + plotH}
                stroke="currentColor"
                className="text-ink/25"
                strokeWidth={1}
                strokeDasharray="2 2"
              />
              <circle
                cx={xFor(hoverIdx)}
                cy={yFor(hover.tvl)}
                r={5}
                fill="var(--color-paper, #fff)"
              />
              <circle
                cx={xFor(hoverIdx)}
                cy={yFor(hover.tvl)}
                r={3}
                fill={lineColor}
              />
            </g>
          )}

          {xAxisTicks(points, n).map(({ i, label }) => (
            <text
              key={i}
              x={xFor(i)}
              y={H - PAD_B + 18}
              textAnchor="middle"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
              className="fill-ink-faint text-[10px] tabular-nums"
            >
              {label}
            </text>
          ))}
        </svg>

        {hover && hoverIdx != null && (
          <Tooltip
            xFrac={xFor(hoverIdx) / W}
            yFrac={yFor(hover.tvl) / H}
            point={hover}
          />
        )}
      </div>
    </div>
  );
}

function Tooltip({
  xFrac,
  yFrac,
  point,
}: {
  xFrac: number;
  yFrac: number;
  point: { date: number; tvl: number };
}) {
  const left = Math.max(4, Math.min(96, xFrac * 100));
  const top = Math.max(8, yFrac * 100 - 8);
  const flipX = left > 70;
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-md border border-ink/15 bg-paper shadow-lg px-3 py-1.5 text-[11.5px]"
      style={{
        left: `${left}%`,
        top: `${top}%`,
        transform: `translate(${flipX ? "-100%" : "0%"}, -100%) translateX(${flipX ? -8 : 8}px) translateY(-8px)`,
        minWidth: 140,
      }}
    >
      <p
        className="label-mono text-[10px] text-ink-faint"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {fmtLongDate(point.date)}
      </p>
      <p className="font-semibold tabular-nums leading-tight">
        {fmtUSD(point.tvl)}
      </p>
    </div>
  );
}

function xAxisTicks(
  points: { date: number; tvl: number }[],
  n: number,
): { i: number; label: string }[] {
  const targetCount = 6;
  const step = Math.max(1, Math.floor(n / targetCount));
  const out: { i: number; label: string }[] = [];
  for (let i = 0; i < n; i += step) {
    out.push({ i, label: fmtShortDate(points[i].date) });
  }
  if (out[out.length - 1]?.i !== n - 1) {
    out.push({ i: n - 1, label: fmtShortDate(points[n - 1].date) });
  }
  return out;
}

function fmtUSD(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000_000) return `$${(v / 1_000_000_000_000).toFixed(2)}T`;
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtUSDShort(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000_000) return `$${(v / 1_000_000_000_000).toFixed(1)}T`;
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtShortDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
}

function fmtLongDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  });
}
