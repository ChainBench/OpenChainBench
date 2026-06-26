import { useMemo, useRef, useState } from "react";
import { useAnimatedDomain } from "@/hooks/use-animated-domain";
import {
  buildXTicks,
  niceTicks,
  type LineWithColor,
} from "./scales";
import { YAxis, XAxis } from "./axis";
import { SeriesGradients, SeriesPaths, HoverMarkers, type DrawnLine } from "./series";
import { Legend } from "./legend";
import { Tooltip } from "./tooltip";

type ChartProps = {
  lines: LineWithColor[];
  unit: string;
  windowHours: number;
  /** Number of samples spec.ts requested for this range. Used to anchor
   *  partial series correctly on the right of the chart instead of
   *  stretching a sparse line across the full width. */
  expectedPoints: number;
  zoom?: { startFrac: number; endFrac: number } | null;
  onZoom?: (next: { startFrac: number; endFrac: number } | null) => void;
  onToggleExclude?: (slug: string) => void;
  onResetExcluded?: () => void;
};

export function Chart({
  lines,
  unit,
  windowHours,
  expectedPoints,
  zoom,
  onZoom,
  onToggleExclude,
  onResetExcluded,
}: ChartProps) {
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
    containerW: number;
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
    // Inverse of the right-anchored point placement used in drawn().
    // offsetFromRight is the fraction of the chart width to the left
    // of "now"; converting to a data-index means scaling by EXPECTED
    // (the step density spec.ts requests) and subtracting from the
    // last index. If the cursor sits in the empty left region beyond
    // actual data, idx clamps to 0 (oldest available point). When
    // zoomed, the visible series fills the chart — so the cursor
    // ratio maps directly to the sliced index range, not the original
    // expectedPoints scale. Mirror the same switch used in drawn().
    const lastIdx = numPoints - 1;
    const expected = Math.max(1, expectedPoints - 1);
    const denom = zoom ? Math.max(1, lastIdx) : expected;
    const offsetFromRight = 1 - ratio;
    const dataOffsetFromLast = offsetFromRight * denom;
    const idx = Math.max(0, Math.min(lastIdx, Math.round(lastIdx - dataOffsetFromLast)));
    setHover({ idx, xPx, yPx, containerW: rect.width });
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
  const drawn: DrawnLine[] = useMemo(() => {
    // Position math: anchor the rightmost point to "now" (right edge)
    // and step earlier points backwards by 1 / (EXPECTED - 1) of the
    // chart width. EXPECTED is the point count spec.ts requests for
    // this range. When the actual series length matches EXPECTED, the
    // formula collapses to the classic i / (len - 1). When the series
    // is shorter (harness recently started, partial coverage), the
    // unfilled left side stays empty instead of stretching a sparse
    // line across the whole range — which used to imply we had data
    // we did not.
    // When the user drag-zooms, the lines should stretch to fill the
    // chart width so the zoomed segment actually reads as zoomed-in. We
    // achieve that by switching the X-axis denominator from the original
    // expectedPoints (which keeps short data anchored to the right) to
    // the sliced lastIdx itself. Without this switch, a 50 % zoom kept
    // the line at 50 % of chart width, anchored right — the user saw
    // their selection compressed into a corner instead of magnified.
    const expected = Math.max(1, expectedPoints - 1);
    return slicedLines.map((l) => {
      const color = l.color;
      const positive = l.values.filter((v) => v > 0);
      const positiveMin = positive.length > 0 ? Math.min(...positive) : 0;
      const isGap = (v: number) => !Number.isFinite(v) || (v === 0 && positiveMin > 1);

      const lastIdx = Math.max(0, l.values.length - 1);
      // If Prom returned more points than the chart was sized for (off-by-one
      // when start/end timestamps are both inclusive), fall back to the
      // actual series length so the leftmost point lands at padL exactly
      // instead of overflowing left of the chart frame. When zoomed, the
      // sliced view should always fill the chart — use lastIdx alone so
      // the leftmost sliced sample maps to padL and the rightmost to
      // padL+innerW.
      const denom = zoom ? Math.max(1, lastIdx) : Math.max(expected, lastIdx);
      const pts = l.values.map((v, i) => {
        const offsetFromRight = (lastIdx - i) / denom;
        const x = padL + innerW * (1 - offsetFromRight);
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
  }, [slicedLines, padL, padT, innerW, innerH, lo, yRange, expectedPoints]);

  // Hover line position: mirror the right-anchored placement used by drawn().
  // hover.idx is in [0, numPoints-1]; we map it to the visible chart via the
  // same offsetFromRight = (last - i) / EXPECTED so the vertical hairline
  // sits exactly on the data point under the cursor. When zoomed, the
  // sliced view spans the full chart width — match the denom switch used
  // in drawn() so the hairline lands on the data point under the cursor.
  const hoverLast = Math.max(1, numPoints - 1);
  const hoverExpected = zoom ? hoverLast : Math.max(1, expectedPoints - 1);
  const hoverOffsetFromRight = hover ? (hoverLast - hover.idx) / hoverExpected : 0;
  const hoverFraction = hover ? 1 - hoverOffsetFromRight : 0;
  const hoverX = hover ? padL + innerW * hoverFraction : null;
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
          <SeriesGradients drawn={drawn} />
        </defs>

        {/* Y gridlines + tick labels */}
        <YAxis
          yTicks={yTicks}
          lo={lo}
          yRange={yRange}
          padL={padL}
          padT={padT}
          padR={padR}
          innerH={innerH}
          W={W}
          unit={unit}
        />

        {/* X tick labels */}
        <XAxis xTicks={xTicks} padL={padL} padT={padT} innerW={innerW} innerH={innerH} />

        {/* Areas + lines */}
        <SeriesPaths drawn={drawn} unit={unit} />

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
            <HoverMarkers
              drawn={drawn}
              hoverX={hoverX}
              hoverIdx={hover.idx}
              numPoints={numPoints}
              padT={padT}
              innerH={innerH}
              lo={lo}
              yRange={yRange}
            />
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
          containerW={hover.containerW || 1}
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
      <Legend
        drawn={drawn}
        unit={unit}
        onToggleExclude={onToggleExclude}
        onResetExcluded={onResetExcluded}
      />

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
