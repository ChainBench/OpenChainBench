"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Globe } from "lucide-react";
import type { Benchmark } from "@/types/benchmark";
import { brandColor } from "@/lib/brand";
import { fmtUnit } from "@/lib/format";
import { buildProviderColors } from "@/lib/series-colors";
import { useChartExclusion } from "@/hooks/use-chart-exclusion";
import { useAnimatedDomain } from "@/hooks/use-animated-domain";
import { LiveDot } from "@/components/live-dot";

type Props = {
  benchmark: Benchmark;
  /** Optional externally-controlled region. When provided, the chart
   *  filters its lines by this value and hides its internal region tabs
   *  (the parent component renders them in a shared dimension row). */
  region?: string;
  /** Optional controlled exclusion set shared with the other chart views
   *  (ranked-bar, distribution, donut). Lets the reader hide a dominant
   *  outlier here too — Y-axis re-zooms smoothly to fit the rest. */
  excluded?: Set<string>;
  onToggleExclude?: (slug: string) => void;
  onResetExcluded?: () => void;
  /** Optional slot rendered in the chart's header row, right-aligned. */
  headerActions?: import("react").ReactNode;
};

type Range = "1h" | "6h" | "24h" | "7d" | "30d";
const RANGES: Range[] = ["1h", "6h", "24h", "7d", "30d"];

const RANGE_HOURS: Record<Range, number> = {
  "1h": 1,
  "6h": 6,
  "24h": 24,
  "7d": 168,
  "30d": 720,
};

const RANGE_LABEL: Record<Range, string> = {
  "1h": "last hour",
  "6h": "last 6 hours",
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
};

const REGION_LABEL: Record<string, string> = {
  "us-east": "US-East",
  "eu-west": "EU-West",
  "ap-southeast": "Singapore",
  sgp: "Singapore",
  global: "Global",
};

export function TimeSeriesChart({
  benchmark,
  region: regionProp,
  excluded: controlledExcluded,
  onToggleExclude,
  onResetExcluded,
  headerActions,
}: Props) {
  const [range, setRange] = useState<Range>("24h");
  const [regionLocal, setRegionLocal] = useState<string>("all");
  const region = regionProp ?? regionLocal;
  const setRegion = regionProp != null ? () => {} : setRegionLocal;
  const { excluded, toggle, reset } = useChartExclusion(
    controlledExcluded,
    onToggleExclude,
    onResetExcluded,
  );
  // Drag-to-zoom state. Fractions are 0..1 of the original visible range
  // for the current Range tab. Lives in the parent so it survives the
  // Chart's internal re-renders. Reset to null when range or region
  // changes (the data shape is different, the old zoom doesn't apply).
  const [zoom, setZoom] = useState<{ startFrac: number; endFrac: number } | null>(null);
  useEffect(() => {
    setZoom(null);
  }, [range, region]);

  const has7d =
    !!benchmark.extras.series7d &&
    Object.keys(benchmark.extras.series7d).length > 0;

  const has30d =
    !!benchmark.extras.series30d &&
    Object.keys(benchmark.extras.series30d).length > 0;

  const availableRegions = useMemo(() => {
    const set = new Set<string>();
    const byRegion = benchmark.extras.seriesByRegion24h ?? {};
    for (const slug of Object.keys(byRegion)) {
      for (const r of Object.keys(byRegion[slug])) set.add(r);
    }
    return Array.from(set).sort();
  }, [benchmark]);

  // Internal region tabs are hidden when the parent controls the region -
  // it renders a unified Chain + Region row above and passes the value down.
  const showRegionTabs = regionProp == null && availableRegions.length > 1;

  const colors = useMemo(
    () => buildProviderColors(benchmark.results),
    [benchmark.results]
  );

  // Build every provider's line up-front so the legend always lists the
  // full set (excluded items stay visible there for re-enable). The
  // `excluded` flag drives both opacity (CSS fade-out) and Y-axis math
  // (excluded values are dropped from min/max so the remaining lines
  // can spread out vertically when an outlier is hidden).
  const lines = useMemo(() => {
    const built = benchmark.results
      .map((r) => ({
        slug: r.slug,
        name: r.name,
        color: colors.get(r.slug) ?? "var(--color-ink-soft)",
        values: pickSeries(benchmark, r.slug, range, region),
        excluded: excluded.has(r.slug),
      }))
      .filter((l) => l.values.length > 0);

    built.sort((a, b) => mean(b.values.slice(-6)) - mean(a.values.slice(-6)));
    return built;
  }, [benchmark, range, region, colors, excluded]);

  // A key that flips when the data shape changes. used to retrigger
  // the line-draw animation.
  const seriesKey = `${range}::${region}`;

  // Format the zoomed-window label so the header tells the reader
  // exactly which slice of the original range they're looking at, e.g.
  // "head lag · −18 h → −12 h (6 h window)". Falls back to the normal
  // range label when no zoom is active.
  const totalWindowH = RANGE_HOURS[range];
  const zoomLabel = zoom
    ? (() => {
        const startAgo = (1 - zoom.startFrac) * totalWindowH;
        const endAgo = (1 - zoom.endFrac) * totalWindowH;
        const spanH = startAgo - endAgo;
        const fmt = (h: number) =>
          h < 0.05
            ? "now"
            : h < 1
              ? `−${Math.round(h * 60)} min`
              : h < 48
                ? `−${h.toFixed(h < 6 ? 1 : 0)} h`
                : `−${(h / 24).toFixed(0)} d`;
        const span =
          spanH < 1
            ? `${Math.round(spanH * 60)} min`
            : spanH < 48
              ? `${spanH.toFixed(spanH < 6 ? 1 : 0)} h`
              : `${(spanH / 24).toFixed(0)} d`;
        return `${fmt(startAgo)} → ${fmt(endAgo)} (${span} window)`;
      })()
    : RANGE_LABEL[range];

  return (
    <figure className="my-2">
      <div className="mb-3 flex items-center justify-between gap-3 min-h-7">
        <p className="inline-flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          <LiveDot />
          <span>
            {benchmark.metric} · {zoomLabel}
          </span>
        </p>
        <div className="flex items-center gap-3">
          {zoom && (
            <button
              type="button"
              onClick={() => setZoom(null)}
              className="inline-flex items-center gap-1.5 rounded-md border border-ink/15 bg-paper px-2.5 py-1 text-[11px] font-sans font-medium uppercase tracking-[0.1em] text-ink shadow-sm transition-all hover:border-ink/40 hover:shadow-md"
              aria-label="Reset chart zoom"
              title="Show the full range again"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 8a5 5 0 1 0 1.5-3.5" />
                <path d="M3 3v3h3" />
              </svg>
              Reset zoom
            </button>
          )}
          {headerActions}
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          {RANGES.map((r) => {
            const active = r === range;
            const disabled =
              (r === "7d" && !has7d) || (r === "30d" && !has30d);
            return (
              <button
                key={r}
                type="button"
                onClick={() => !disabled && setRange(r)}
                disabled={disabled}
                className={[
                  "rounded px-2.5 py-1 text-[11px] font-sans tabular uppercase tracking-[0.1em] font-medium transition-colors",
                  active
                    ? "bg-ink text-paper"
                    : "text-ink-muted hover:text-ink hover:bg-paper-soft",
                  disabled ? "opacity-40 cursor-not-allowed" : "",
                ].join(" ")}
                title={
                  disabled
                    ? `${r} retention not available yet`
                    : undefined
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
              slug="all"
              label="All"
              active={region === "all"}
              onClick={() => setRegion("all")}
            />
            {availableRegions.map((r) => (
              <RegionTab
                key={r}
                slug={r}
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
          zoom={zoom}
          onZoom={setZoom}
          onToggleExclude={toggle}
          onResetExcluded={excluded.size > 0 ? reset : undefined}
        />
      )}
    </figure>
  );
}

function RegionTab({
  slug,
  label,
  active,
  onClick,
}: {
  slug: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const accent = brandColor(slug);
  const activeStyle = active
    ? { background: accent ?? "var(--color-ink)", color: "var(--color-paper)" }
    : undefined;
  const className = active
    ? "rounded-md px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] shadow-sm transition-colors"
    : "rounded-md px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] border border-rule text-ink-muted hover:text-ink hover:bg-paper-soft transition-colors";
  return (
    <button type="button" onClick={onClick} style={activeStyle} className={className}>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-flex items-center justify-center rounded-full"
          style={{
            width: 14,
            height: 14,
            background: active ? "rgba(255,255,255,0.18)" : (accent ?? "var(--color-ink-soft)"),
            color: "var(--color-paper)",
          }}
        >
          <Globe size={9} strokeWidth={2.2} />
        </span>
        {label}
      </span>
    </button>
  );
}

type LineWithColor = {
  slug: string;
  name: string;
  color: string;
  values: number[];
  excluded: boolean;
};

function Chart({
  lines,
  unit,
  windowHours,
  zoom,
  onZoom,
  onToggleExclude,
  onResetExcluded,
}: {
  lines: LineWithColor[];
  unit: string;
  windowHours: number;
  zoom?: { startFrac: number; endFrac: number } | null;
  onZoom?: (next: { startFrac: number; endFrac: number } | null) => void;
  onToggleExclude?: (slug: string) => void;
  onResetExcluded?: () => void;
}) {
  const W = 1000;
  const H = 360;
  const padL = 60;
  const padR = 96;
  const padT = 16;
  const padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  // Apply drag-to-zoom by slicing each line's values to the zoom window.
  // The sliced series still uses the full chart width so the zoomed
  // segment naturally expands. windowHours / endHoursAgo shrink + offset
  // accordingly for the X-axis labels and the hover tooltip.
  const zoomedWindowHours = zoom
    ? Math.max(0.0167, (zoom.endFrac - zoom.startFrac) * windowHours)
    : windowHours;
  const endHoursAgo = zoom ? (1 - zoom.endFrac) * windowHours : 0;

  const slicedLines = useMemo(() => {
    if (!zoom) return lines;
    return lines.map((l) => {
      const n = l.values.length;
      if (n < 2) return l;
      const startIdx = Math.max(0, Math.floor(zoom.startFrac * (n - 1)));
      const endIdx = Math.min(n - 1, Math.ceil(zoom.endFrac * (n - 1)));
      return { ...l, values: l.values.slice(startIdx, endIdx + 1) };
    });
  }, [lines, zoom]);

  // Y-axis bounds come from VISIBLE values only so excluding a dominant
  // outlier (e.g. GeckoTerminal at 11s while the others sit under 1s)
  // lets the remaining lines spread out. If everything is excluded we
  // fall back to the full set so the axis doesn't collapse.
  const visibleValues = slicedLines.filter((l) => !l.excluded).flatMap((l) => l.values);
  const sourceValues = visibleValues.length > 0 ? visibleValues : slicedLines.flatMap((l) => l.values);
  const dataMin = Math.min(...sourceValues);
  const dataMax = Math.max(...sourceValues);
  const targetTicks = niceTicks(dataMin, dataMax, 4);
  const { lo, hi } = useAnimatedDomain(targetTicks.lo, targetTicks.hi);
  // Recompute the tick set against the animated bounds so the gridline
  // labels morph in sync with the line geometry. niceTicks rounds to
  // human-friendly steps so the morphing reads as smooth re-scaling.
  const { yTicks } = niceTicks(lo, hi, 4);
  const yRange = hi - lo;

  const xTicks = buildXTicks(zoomedWindowHours, endHoursAgo);
  const numPoints = Math.max(...slicedLines.map((l) => l.values.length));

  // Hover state
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{
    idx: number;
    xPx: number;
    yPx: number;
  } | null>(null);

  // Drag-to-zoom state. `dragFrac` is the [start, current] pair while
  // the mouse is held. On mouse-up we commit to the parent's zoom via
  // onZoom if the drag distance is meaningful (otherwise treat as click
  // and skip the zoom — guards against accidental tiny drags).
  const [dragFrac, setDragFrac] = useState<{ start: number; current: number } | null>(null);
  const MIN_DRAG_FRACTION = 0.02; // 2% of innerW. Anything smaller = click, not zoom.

  // Map a mouse event to a fractional X position within the plot area
  // (0 = padL edge, 1 = W-padR edge), clamped to [0, 1].
  const xFractionFromEvent = (e: React.MouseEvent<HTMLDivElement>): number | null => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const rect = wrap.getBoundingClientRect();
    const xVB = ((e.clientX - rect.left) / rect.width) * W;
    const ratio = (xVB - padL) / innerW;
    return Math.max(0, Math.min(1, ratio));
  };

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;
    const xVB = (xPx / rect.width) * W;

    // While a drag is in progress, track the moving edge for the
    // selection rect. Tooltip stays hidden during drag so the two
    // overlays don't compete for the cursor.
    if (dragFrac) {
      const frac = xFractionFromEvent(e);
      if (frac != null) setDragFrac({ start: dragFrac.start, current: frac });
      setHover(null);
      return;
    }

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

  const onDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onZoom || numPoints < 2) return;
    if (e.button !== 0) return; // left click only
    const frac = xFractionFromEvent(e);
    if (frac == null) return;
    setDragFrac({ start: frac, current: frac });
    setHover(null);
  };

  const commitDrag = () => {
    if (!dragFrac || !onZoom) {
      setDragFrac(null);
      return;
    }
    const a = Math.min(dragFrac.start, dragFrac.current);
    const b = Math.max(dragFrac.start, dragFrac.current);
    if (b - a >= MIN_DRAG_FRACTION) {
      // Compose with existing zoom: drag fractions are in the *visible*
      // window, so when we're already zoomed [z.startFrac, z.endFrac]
      // a sub-drag of [a, b] maps to the absolute fractions below.
      if (zoom) {
        const span = zoom.endFrac - zoom.startFrac;
        onZoom({
          startFrac: zoom.startFrac + a * span,
          endFrac: zoom.startFrac + b * span,
        });
      } else {
        onZoom({ startFrac: a, endFrac: b });
      }
    }
    setDragFrac(null);
  };

  // Per-line drawn paths (memoised for animation re-trigger via key).
  // Treats hard zeroes among non-zero data as gaps (no-data) rather than
  // drawing the line down to zero. A sustained outage shows as a missing
  // segment instead of a misleading "0%" cliff.
  const drawn = useMemo(() => {
    return slicedLines.map((l) => {
      const color = l.color;
      const positive = l.values.filter((v) => v > 0);
      const positiveMin = positive.length > 0 ? Math.min(...positive) : 0;
      const isGap = (v: number) => !Number.isFinite(v) || (v === 0 && positiveMin > 1);

      const pts = l.values.map((v, i) => {
        const x = padL + innerW * (i / Math.max(1, l.values.length - 1));
        const y = padT + innerH * (1 - (v - lo) / yRange);
        return { x, y, gap: isGap(v) } as const;
      });

      // Build line path with `M` at gap boundaries to break the stroke.
      let linePath = "";
      let openingSegment = true;
      for (const p of pts) {
        if (p.gap) {
          openingSegment = true;
          continue;
        }
        const cmd = openingSegment ? "M" : "L";
        linePath += `${cmd} ${p.x.toFixed(2)},${p.y.toFixed(2)} `;
        openingSegment = false;
      }
      linePath = linePath.trim();

      // Fill path uses the same gap logic - closes at base on each break.
      const baseY = padT + innerH;
      let fillPath = "";
      let segStart: { x: number; y: number } | null = null;
      const closeSegment = (endX: number) => {
        if (segStart) {
          fillPath += `L ${endX.toFixed(2)},${baseY.toFixed(2)} Z `;
          segStart = null;
        }
      };
      for (const p of pts) {
        if (p.gap) {
          // close current segment at the last drawn x
          // (the previous point's x - but we only know prev via state)
          continue;
        }
        if (!segStart) {
          fillPath += `M ${p.x.toFixed(2)},${baseY.toFixed(2)} L ${p.x.toFixed(2)},${p.y.toFixed(2)} `;
          segStart = { x: p.x, y: p.y };
        } else {
          fillPath += `L ${p.x.toFixed(2)},${p.y.toFixed(2)} `;
        }
      }
      // Close any open segment at its last x
      const lastDrawn = [...pts].reverse().find((p) => !p.gap);
      if (lastDrawn) closeSegment(lastDrawn.x);

      // End-of-line label uses the last non-gap value.
      const last = lastDrawn ? l.values[pts.indexOf(lastDrawn)] : 0;
      const lastX = lastDrawn ? lastDrawn.x : padL + innerW;
      const lastY = lastDrawn ? lastDrawn.y : padT + innerH;
      // Expose isGap so the hover dot + tooltip can drop a sample that
      // sits inside a gap (provider stopped emitting). Otherwise the
      // line draws a break but the dot keeps rendering at 0 / NaN.
      return { ...l, color, pts, linePath, fillPath, lastX, lastY, last, isGap };
    });
  }, [slicedLines, padL, padR, padT, padB, innerW, innerH, lo, yRange]);

  const hoverX = hover ? padL + innerW * (hover.idx / Math.max(1, numPoints - 1)) : null;
  const hoverFraction = hover ? hover.idx / Math.max(1, numPoints - 1) : 0;
  // hoursAgo is computed against the VISIBLE window — if the chart is
  // zoomed in, the visible window is shorter and the rightmost point
  // sits at endHoursAgo (not 0). hoverHoursAgo follows.
  const hoverHoursAgo = hover
    ? endHoursAgo + zoomedWindowHours * (1 - hoverFraction)
    : 0;

  const dragRectX = dragFrac
    ? padL + innerW * Math.min(dragFrac.start, dragFrac.current)
    : null;
  const dragRectW = dragFrac
    ? innerW * Math.abs(dragFrac.current - dragFrac.start)
    : 0;

  // Tooltip layout (sorted by value at hover, descending). Two subtleties:
  // (1) excluded providers are dropped so a faded line doesn't get a row;
  // (2) different lines can have different point counts (provider added
  //     later, missing samples from Prom), so we map the global hover.idx
  //     to each line's own proportional index before looking up the
  //     value. Gap samples are dropped so a stopped provider doesn't
  //     keep showing the last-known number.
  const tooltipRows = useMemo(() => {
    if (!hover) return null;
    const globalFraction =
      numPoints > 1 ? hover.idx / (numPoints - 1) : 0;
    return [...drawn]
      .filter((d) => !d.excluded)
      .map((d) => {
        const localIdx =
          d.values.length > 1
            ? Math.round(globalFraction * (d.values.length - 1))
            : 0;
        const value = d.values[localIdx];
        return { ...d, value };
      })
      .filter((d) => Number.isFinite(d.value) && !d.isGap(d.value))
      .sort((a, b) => b.value - a.value);
  }, [drawn, hover, numPoints]);

  return (
    <div
      ref={wrapRef}
      className="relative select-none"
      style={{ cursor: onZoom ? (dragFrac ? "ew-resize" : "crosshair") : undefined }}
      onMouseMove={onMove}
      onMouseDown={onDown}
      onMouseUp={commitDrag}
      onMouseLeave={() => {
        setHover(null);
        if (dragFrac) commitDrag();
      }}
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
          const isBound = i === 0 || i === yTicks.length - 1;
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
            <g
              key={d.slug}
              className="ts-line"
              style={{
                opacity: d.excluded ? 0 : 1,
                pointerEvents: d.excluded ? "none" : undefined,
                transition: "opacity 0.3s ease-out",
              }}
            >
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
              {/* Live pulse halo. animated outward */}
              <circle cx={d.lastX} cy={d.lastY} r={3} fill={d.color} opacity={0.4}>
                <animate
                  attributeName="r"
                  values="3;10;3"
                  dur="1.8s"
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="0.45;0;0.45"
                  dur="1.8s"
                  repeatCount="indefinite"
                />
              </circle>
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

        {/* Drag-to-zoom selection rect. Brushed window highlighted in
            the foreground tint; mouse-up commits to zoom (Y-axis then
            re-scales via useAnimatedDomain). */}
        {dragFrac && dragRectW > 1 && (
          <g style={{ pointerEvents: "none" }}>
            <rect
              x={dragRectX ?? padL}
              y={padT}
              width={dragRectW}
              height={innerH}
              fill="var(--color-ink)"
              opacity={0.08}
            />
            <line
              x1={dragRectX ?? padL}
              x2={dragRectX ?? padL}
              y1={padT}
              y2={padT + innerH}
              stroke="var(--color-ink)"
              strokeWidth={1}
              opacity={0.4}
            />
            <line
              x1={(dragRectX ?? padL) + dragRectW}
              x2={(dragRectX ?? padL) + dragRectW}
              y1={padT}
              y2={padT + innerH}
              stroke="var(--color-ink)"
              strokeWidth={1}
              opacity={0.4}
            />
          </g>
        )}

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
              if (d.excluded) return null;
              // Map the global crosshair index to this line's own continuous
              // index AND interpolate Y between bracketing samples so the
              // dot lands exactly on the rendered line at hover-X. Round to
              // nearest sample snapped the dot to a single sample's value,
              // which disagreed visually with the line during steep slopes
              // (the line is drawn as straight SVG segments M…L…L…, so the
              // line's Y at hoverX is lerp(v[N], v[N+1], t) — match it here).
              const globalFraction =
                numPoints > 1 ? hover.idx / (numPoints - 1) : 0;
              if (d.values.length === 0) return null;
              const fract = globalFraction * (d.values.length - 1);
              const i0 = Math.floor(fract);
              const i1 = Math.min(i0 + 1, d.values.length - 1);
              const t = fract - i0;
              const v0 = d.values[i0];
              const v1 = d.values[i1];
              // If either bracketing sample is a gap, the line itself is
              // broken here (drawn as `M` not `L`) — skip the dot so we
              // don't paint over a missing segment.
              if (!Number.isFinite(v0) || !Number.isFinite(v1)) return null;
              if (d.isGap(v0) || d.isGap(v1)) return null;
              const v = v0 + (v1 - v0) * t;
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

      {/* Compact legend below chart. Clicking a provider toggles exclusion;
          Y-axis re-zooms smoothly (useAnimatedDomain) so the remaining
          lines spread out. Excluded items stay listed (greyed + line-through)
          for re-enable. */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-t border-rule pt-3">
        <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {drawn.map((d) => {
            const clickable = !!onToggleExclude;
            return (
              <li key={d.slug}>
                <button
                  type="button"
                  onClick={clickable ? () => onToggleExclude(d.slug) : undefined}
                  disabled={!clickable}
                  aria-pressed={d.excluded}
                  className={`inline-flex items-center gap-2 text-[12px] transition-opacity duration-200 ${
                    clickable ? "cursor-pointer hover:opacity-80" : "cursor-default"
                  } ${d.excluded ? "opacity-40" : ""}`}
                >
                  <span
                    className="inline-block h-px w-5"
                    style={{ background: d.color }}
                  />
                  <span
                    className={`font-medium ${
                      d.excluded ? "text-ink-faint line-through decoration-1" : "text-ink"
                    }`}
                  >
                    {d.name}
                  </span>
                  <span className="font-sans tabular text-ink-muted text-[11px]">
                    {fmtUnit(d.last, unit)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {onResetExcluded && (
          <button
            type="button"
            onClick={onResetExcluded}
            className="text-[10px] font-sans font-medium uppercase tracking-[0.16em] text-ink-muted hover:text-ink lnk"
          >
            Reset
          </button>
        )}
      </div>

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
        className="rounded border border-rule bg-paper-soft/95 backdrop-blur-sm shadow-[0_12px_28px_-16px_rgba(28,26,23,0.25)] px-3 py-2.5 min-w-[12rem] sm:min-w-[14rem] max-w-[calc(100vw-2rem)] text-[11px]"
        style={{
          animation: "ts-tooltip-in 0.15s ease-out forwards",
        }}
      >
        <p className="font-sans tabular uppercase tracking-[0.12em] text-ink-muted font-medium">
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
              <span className="font-sans tabular text-ink-soft">
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
    if (range === "30d") {
      return benchmark.extras.seriesByRegion30d?.[slug]?.[region] ?? [];
    }
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
  const s30 = benchmark.extras.series30d?.[slug] ?? [];
  if (range === "30d") return s30;
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

/**
 * X-axis ticks for the visible window. When the chart is zoomed the
 * right edge isn't `now` anymore — pass `endHoursAgo` to offset every
 * tick by that many hours (the rightmost tick becomes `−{endHoursAgo}h`
 * instead of `now`). The label granularity (minutes / hours / days) is
 * picked from the *visible* windowHours so a 6-hour zoom-in of a 24h
 * range gets minute-level ticks.
 */
function buildXTicks(windowHours: number, endHoursAgo: number = 0) {
  const ticks: { pct: number; label: string }[] = [];
  const step = 0.25;
  for (let p = 0; p <= 1; p += step) {
    const ago = endHoursAgo + windowHours * (1 - p);
    let label: string;
    if (ago < 0.001) label = "now";
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

// niceTicks picks rounded y-axis bounds + tick values so labels read as
// 0%, 25%, 50%, 75%, 100% rather than 18.2%, 36.4%, 54.6%, 72.8%.
function niceTicks(
  dataMin: number,
  dataMax: number,
  targetCount: number
): { lo: number; hi: number; yTicks: number[] } {
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
    return { lo: 0, hi: 1, yTicks: [0, 0.25, 0.5, 0.75, 1] };
  }
  if (dataMin === dataMax) {
    const v = dataMin;
    return { lo: v - 1, hi: v + 1, yTicks: [v - 1, v, v + 1] };
  }
  const rawSpan = dataMax - dataMin;
  const rawStep = rawSpan / targetCount;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  // Pick the smallest "nice" step >= raw step. 1, 2, 2.5, 5, 10
  let niceStep: number;
  if (norm <= 1) niceStep = 1;
  else if (norm <= 2) niceStep = 2;
  else if (norm <= 2.5) niceStep = 2.5;
  else if (norm <= 5) niceStep = 5;
  else niceStep = 10;
  niceStep *= mag;
  const lo = Math.max(0, Math.floor(dataMin / niceStep) * niceStep);
  const hi = Math.ceil(dataMax / niceStep) * niceStep;
  const yTicks: number[] = [];
  for (let v = lo; v <= hi + niceStep / 2; v += niceStep) yTicks.push(v);
  return { lo, hi, yTicks };
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

