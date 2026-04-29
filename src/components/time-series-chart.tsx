"use client";

import { useMemo, useRef, useState } from "react";
import type { Benchmark } from "@/types/benchmark";
import { fmtUnit } from "@/lib/format";
import { buildProviderColors } from "@/lib/series-colors";

type Props = {
  benchmark: Benchmark;
};

type Range = "1h" | "6h" | "24h" | "7d";
const RANGES: Range[] = ["1h", "6h", "24h", "7d"];

const RANGE_HOURS: Record<Range, number> = {
  "1h": 1,
  "6h": 6,
  "24h": 24,
  "7d": 168,
};

const REGION_LABEL: Record<string, string> = {
  "us-east": "US-East",
  "eu-west": "EU-West",
  "ap-southeast": "AP-Southeast",
  global: "Global",
};

export function TimeSeriesChart({ benchmark }: Props) {
  const [range, setRange] = useState<Range>("24h");
  const [region, setRegion] = useState<string>("all");

  const has7d =
    !!benchmark.extras.series7d &&
    Object.keys(benchmark.extras.series7d).length > 0;

  const availableRegions = useMemo(() => {
    const set = new Set<string>();
    const byRegion = benchmark.extras.seriesByRegion24h ?? {};
    for (const slug of Object.keys(byRegion)) {
      for (const r of Object.keys(byRegion[slug])) set.add(r);
    }
    return Array.from(set).sort();
  }, [benchmark]);

  const showRegionTabs = availableRegions.length > 1;

  const colors = useMemo(
    () => buildProviderColors(benchmark.results),
    [benchmark.results]
  );

  const lines = useMemo(() => {
    const built = benchmark.results
      .map((r) => ({
        slug: r.slug,
        name: r.name,
        color: colors.get(r.slug) ?? "var(--color-ink-soft)",
        values: pickSeries(benchmark, r.slug, range, region),
      }))
      .filter((l) => l.values.length > 0);

    built.sort((a, b) => mean(b.values.slice(-6)) - mean(a.values.slice(-6)));
    return built;
  }, [benchmark, range, region, colors]);

  // A key that flips when the data shape changes — used to retrigger
  // the line-draw animation.
  const seriesKey = `${range}::${region}`;

  return (
    <figure className="my-2">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          {RANGES.map((r) => {
            const active = r === range;
            const disabled = r === "7d" && !has7d;
            return (
              <button
                key={r}
                type="button"
                onClick={() => !disabled && setRange(r)}
                disabled={disabled}
                className={[
                  "rounded px-2.5 py-1 text-[11px] font-mono tabular uppercase tracking-[0.1em] transition-colors",
                  active
                    ? "bg-ink text-paper"
                    : "text-ink-muted hover:text-ink hover:bg-paper-soft",
                  disabled ? "opacity-40 cursor-not-allowed" : "",
                ].join(" ")}
                title={
                  disabled ? "7-day retention not available yet" : undefined
                }
              >
                {r}
              </button>
            );
          })}
        </div>

        {showRegionTabs && (
          <div className="flex items-center gap-1">
            <span className="mr-2 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
              Region
            </span>
            <RegionTab
              label="All"
              active={region === "all"}
              onClick={() => setRegion("all")}
            />
            {availableRegions.map((r) => (
              <RegionTab
                key={r}
                label={REGION_LABEL[r] ?? r}
                active={region === r}
                onClick={() => setRegion(r)}
              />
            ))}
          </div>
        )}
      </div>

      {lines.length === 0 ? (
        <div className="border-y-2 border-ink py-12 text-center text-ink-muted text-sm">
          No time-series data emitted for this range yet.
        </div>
      ) : (
        <Chart
          key={seriesKey}
          lines={lines as LineWithColor[]}
          unit={benchmark.unit}
          windowHours={RANGE_HOURS[range]}
        />
      )}
    </figure>
  );
}

function RegionTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded px-2.5 py-1 text-[11px] font-mono tabular uppercase tracking-[0.1em] transition-colors",
        active
          ? "bg-ink text-paper"
          : "text-ink-muted hover:text-ink hover:bg-paper-soft",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

type LineWithColor = {
  slug: string;
  name: string;
  color: string;
  values: number[];
};

function Chart({
  lines,
  unit,
  windowHours,
}: {
  lines: LineWithColor[];
  unit: string;
  windowHours: number;
}) {
  const W = 1000;
  const H = 360;
  const padL = 60;
  const padR = 96;
  const padT = 16;
  const padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const allValues = lines.flatMap((l) => l.values);
  const yMin = Math.min(...allValues);
  const yMax = Math.max(...allValues);
  const yPad = (yMax - yMin) * 0.1 || 1;
  const lo = Math.max(0, yMin - yPad);
  const hi = yMax + yPad;
  const yRange = hi - lo;

  const yTickCount = 4;
  const yTicks: number[] = [];
  for (let i = 0; i <= yTickCount; i++)
    yTicks.push(lo + (yRange * i) / yTickCount);

  const xTicks = buildXTicks(windowHours);
  const numPoints = Math.max(...lines.map((l) => l.values.length));

  // Hover state
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{
    idx: number;
    xPx: number;
    yPx: number;
  } | null>(null);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;
    const xVB = (xPx / rect.width) * W;
    if (xVB < padL || xVB > W - padR || numPoints < 2) {
      setHover(null);
      return;
    }
    const ratio = (xVB - padL) / innerW;
    const idx = Math.max(
      0,
      Math.min(numPoints - 1, Math.round(ratio * (numPoints - 1)))
    );
    setHover({ idx, xPx, yPx });
  };

  // Per-line drawn paths (memoised for animation re-trigger via key)
  const drawn = useMemo(() => {
    return lines.map((l) => {
      const color = l.color;
      const pts = l.values.map((v, i) => {
        const x = padL + innerW * (i / Math.max(1, l.values.length - 1));
        const y = padT + innerH * (1 - (v - lo) / yRange);
        return [x, y] as const;
      });
      const linePath = pts
        .map(([x, y], i) =>
          i === 0 ? `M ${x.toFixed(2)},${y.toFixed(2)}` : `L ${x.toFixed(2)},${y.toFixed(2)}`
        )
        .join(" ");
      const baseY = padT + innerH;
      const fillPath =
        `M ${pts[0][0].toFixed(2)},${baseY.toFixed(2)} ` +
        pts.map(([x, y]) => `L ${x.toFixed(2)},${y.toFixed(2)}`).join(" ") +
        ` L ${pts[pts.length - 1][0].toFixed(2)},${baseY.toFixed(2)} Z`;
      const last = l.values[l.values.length - 1];
      const lastX = padL + innerW;
      const lastY = padT + innerH * (1 - (last - lo) / yRange);
      return { ...l, color, pts, linePath, fillPath, lastX, lastY, last };
    });
  }, [lines, padL, padR, padT, padB, innerW, innerH, lo, yRange]);

  const hoverX = hover ? padL + innerW * (hover.idx / Math.max(1, numPoints - 1)) : null;
  const hoverFraction = hover ? hover.idx / Math.max(1, numPoints - 1) : 0;
  const hoverHoursAgo = hover ? windowHours * (1 - hoverFraction) : 0;

  // Tooltip layout (sorted by value at hover, descending)
  const tooltipRows = useMemo(() => {
    if (!hover) return null;
    return [...drawn]
      .map((d) => ({ ...d, value: d.values[hover.idx] ?? d.last }))
      .filter((d) => Number.isFinite(d.value))
      .sort((a, b) => b.value - a.value);
  }, [drawn, hover]);

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full h-auto"
        role="img"
        aria-label={`Last ${windowHours} hours`}
      >
        <defs>
          {drawn.map((d) => (
            <linearGradient
              key={d.slug}
              id={`fill-${d.slug}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={d.color} stopOpacity="0.10" />
              <stop offset="100%" stopColor={d.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {/* Y gridlines + tick labels */}
        {yTicks.map((v, i) => {
          const y = padT + innerH * (1 - (v - lo) / yRange);
          const isBound = i === 0 || i === yTickCount;
          return (
            <g key={i}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                stroke="var(--color-rule)"
                strokeWidth={isBound ? 1 : 0.5}
                strokeDasharray={isBound ? "0" : "2 4"}
              />
              <text
                x={padL - 8}
                y={y}
                dominantBaseline="middle"
                textAnchor="end"
                fontFamily="var(--font-mono)"
                fontSize="10"
                fill="var(--color-ink-muted)"
              >
                {fmtTick(v, unit)}
              </text>
            </g>
          );
        })}

        {/* X tick labels */}
        {xTicks.map((t, i) => {
          const x = padL + innerW * t.pct;
          return (
            <g key={i}>
              <line
                x1={x}
                x2={x}
                y1={padT + innerH}
                y2={padT + innerH + 4}
                stroke="var(--color-rule)"
                strokeWidth={0.8}
              />
              <text
                x={x}
                y={padT + innerH + 18}
                textAnchor={
                  i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"
                }
                fontFamily="var(--font-mono)"
                fontSize="10"
                fill="var(--color-ink-muted)"
              >
                {t.label}
              </text>
            </g>
          );
        })}

        {/* Areas + lines */}
        {drawn.map((d) => {
          const dimmed = hover && hover.idx >= 0; // when hovering, slightly mute non-hovered? No, keep all visible.
          void dimmed;
          return (
            <g key={d.slug} className="ts-line">
              <path d={d.fillPath} fill={`url(#fill-${d.slug})`} />
              <path
                d={d.linePath}
                fill="none"
                stroke={d.color}
                strokeWidth={1.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength={1}
                strokeDasharray="1"
                style={{
                  // Trigger draw-in via CSS animation
                  animation: "ts-draw 0.7s ease-out forwards",
                }}
              />
              {/* Trailing tail dot */}
              <circle cx={d.lastX} cy={d.lastY} r={2.8} fill={d.color} />
              {/* End-of-line label */}
              <text
                x={d.lastX + 8}
                y={d.lastY}
                dominantBaseline="middle"
                fontFamily="var(--font-sans)"
                fontSize="11"
                fontWeight="500"
                fill={d.color}
              >
                {d.name}
              </text>
              <text
                x={d.lastX + 8}
                y={d.lastY + 12}
                dominantBaseline="middle"
                fontFamily="var(--font-mono)"
                fontSize="10"
                fill="var(--color-ink-muted)"
              >
                {fmtUnit(d.last, unit)}
              </text>
            </g>
          );
        })}

        {/* Crosshair + hover dots */}
        {hover && hoverX != null && (
          <g style={{ pointerEvents: "none" }}>
            <line
              x1={hoverX}
              x2={hoverX}
              y1={padT}
              y2={padT + innerH}
              stroke="var(--color-ink)"
              strokeWidth={0.8}
              strokeDasharray="2 3"
              opacity={0.5}
            />
            {drawn.map((d) => {
              const v = d.values[hover.idx];
              if (!Number.isFinite(v)) return null;
              const cy = padT + innerH * (1 - (v - lo) / yRange);
              return (
                <g key={d.slug}>
                  <circle
                    cx={hoverX}
                    cy={cy}
                    r={4}
                    fill="var(--color-paper)"
                    stroke={d.color}
                    strokeWidth={1.8}
                  />
                </g>
              );
            })}
          </g>
        )}

        {/* "now" guide and Y-axis */}
        <line
          x1={padL + innerW}
          x2={padL + innerW}
          y1={padT}
          y2={padT + innerH}
          stroke="var(--color-rule)"
          strokeWidth={0.8}
          strokeDasharray="2 3"
        />
        <line
          x1={padL}
          x2={padL}
          y1={padT}
          y2={padT + innerH}
          stroke="var(--color-ink)"
          strokeWidth={1}
        />
      </svg>

      {/* Floating tooltip */}
      {hover && tooltipRows && tooltipRows.length > 0 && (
        <Tooltip
          xPx={hover.xPx}
          yPx={hover.yPx}
          containerW={wrapRef.current?.getBoundingClientRect().width ?? 1}
          hoursAgo={hoverHoursAgo}
          windowHours={windowHours}
          unit={unit}
          rows={tooltipRows}
        />
      )}

      {/* Compact legend below chart */}
      <ul className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule pt-3">
        {drawn.map((d) => (
          <li
            key={d.slug}
            className="inline-flex items-center gap-2 text-[12px]"
          >
            <span
              className="inline-block h-px w-5"
              style={{ background: d.color }}
            />
            <span className="text-ink font-medium">{d.name}</span>
            <span className="font-mono tabular text-ink-muted text-[11px]">
              {fmtUnit(d.last, unit)}
            </span>
          </li>
        ))}
      </ul>

      {/* CSS animations */}
      <style>{`
        @keyframes ts-draw {
          from { stroke-dashoffset: 1; }
          to   { stroke-dashoffset: 0; }
        }
        .ts-line path[d] { transition: opacity 0.2s ease; }
      `}</style>
    </div>
  );
}

function Tooltip({
  xPx,
  yPx,
  containerW,
  hoursAgo,
  windowHours,
  unit,
  rows,
}: {
  xPx: number;
  yPx: number;
  containerW: number;
  hoursAgo: number;
  windowHours: number;
  unit: string;
  rows: {
    slug: string;
    name: string;
    color: string;
    value: number;
  }[];
}) {
  // Flip the tooltip to the left of the cursor when near the right edge
  const flipLeft = xPx > containerW * 0.6;
  const offsetX = 14;
  const left = flipLeft ? undefined : xPx + offsetX;
  const right = flipLeft ? containerW - xPx + offsetX : undefined;

  // Anchor tooltip vertically to top of visible area but follow cursor a bit
  const top = Math.max(8, Math.min(yPx - 28, 320));

  return (
    <div
      className="pointer-events-none absolute z-10"
      style={{
        left,
        right,
        top,
      }}
    >
      <div
        className="rounded border border-rule bg-paper-soft/95 backdrop-blur-sm shadow-[0_12px_28px_-16px_rgba(28,26,23,0.25)] px-3 py-2.5 min-w-[14rem] text-[11px]"
        style={{
          animation: "ts-tooltip-in 0.15s ease-out forwards",
        }}
      >
        <p className="font-mono tabular uppercase tracking-[0.12em] text-ink-muted">
          {formatHoursAgo(hoursAgo, windowHours)}
        </p>
        <ul className="mt-2 space-y-1">
          {rows.map((r) => (
            <li
              key={r.slug}
              className="grid grid-cols-[10px_1fr_auto] items-center gap-2"
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: r.color }}
              />
              <span className="text-ink truncate">{r.name}</span>
              <span className="font-mono tabular text-ink-soft">
                {fmtUnit(r.value, unit)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <style>{`
        @keyframes ts-tooltip-in {
          from { opacity: 0; transform: translateY(2px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

function pickSeries(
  benchmark: Benchmark,
  slug: string,
  range: Range,
  region: string
): number[] {
  const isAll = region === "all";

  if (!isAll) {
    if (range === "7d") {
      return benchmark.extras.seriesByRegion7d?.[slug]?.[region] ?? [];
    }
    const base = benchmark.extras.seriesByRegion24h?.[slug]?.[region] ?? [];
    if (range === "24h") return base;
    const ratio = RANGE_HOURS[range] / 24;
    const take = Math.max(2, Math.round(base.length * ratio));
    return base.slice(-take);
  }

  const s24 = benchmark.extras.series24h[slug] ?? [];
  const s7 = benchmark.extras.series7d?.[slug] ?? [];
  if (range === "7d") return s7;
  if (range === "24h") return s24;
  const ratio = RANGE_HOURS[range] / 24;
  const take = Math.max(2, Math.round(s24.length * ratio));
  return s24.slice(-take);
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function buildXTicks(windowHours: number) {
  const ticks: { pct: number; label: string }[] = [];
  const step = 0.25;
  for (let p = 0; p <= 1; p += step) {
    const ago = windowHours * (1 - p);
    let label: string;
    if (ago === 0) label = "now";
    else if (windowHours <= 6) {
      const m = Math.round(ago * 60);
      label = `−${m}m`;
    } else if (windowHours <= 48) {
      label = `−${Math.round(ago)}h`;
    } else {
      label = `−${(ago / 24).toFixed(0)}d`;
    }
    ticks.push({ pct: p, label });
  }
  return ticks;
}

function formatHoursAgo(hoursAgo: number, windowHours: number): string {
  if (hoursAgo <= 0.001) return "now";
  if (windowHours <= 6) {
    const m = Math.round(hoursAgo * 60);
    return `−${m} min`;
  }
  if (windowHours <= 48) {
    const h = Math.floor(hoursAgo);
    const m = Math.round((hoursAgo - h) * 60);
    if (h === 0) return `−${m} min`;
    return m > 0 ? `−${h}h ${m}m` : `−${h}h`;
  }
  const d = Math.floor(hoursAgo / 24);
  const h = Math.round(hoursAgo - d * 24);
  return d === 0 ? `−${h}h` : h > 0 ? `−${d}d ${h}h` : `−${d}d`;
}

function fmtTick(v: number, unit: string) {
  if (v === 0) return "0";
  if (unit === "pct") {
    if (v >= 1) return `${v.toFixed(1)}%`;
    if (v >= 0.1) return `${v.toFixed(2)}%`;
    return `${v.toFixed(3)}%`;
  }
  if (unit === "bps") {
    const pct = v / 100;
    if (pct >= 1) return `${pct.toFixed(1)}%`;
    return `${pct.toFixed(2)}%`;
  }
  if (unit === "s") {
    const s = v / 1000;
    if (s >= 60) return `${(s / 60).toFixed(0)}m`;
    return `${s.toFixed(s >= 10 ? 0 : 1)}s`;
  }
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.round(v)}ms`;
}

