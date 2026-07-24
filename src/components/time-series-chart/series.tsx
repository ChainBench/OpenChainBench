import { fmtUnit } from "@/lib/format";
import type { LineWithColor } from "./scales";

export type DrawnLine = LineWithColor & {
  pts: ReadonlyArray<{ x: number; y: number; gap: boolean }>;
  linePath: string;
  fillPath: string;
  lastX: number;
  lastY: number;
  last: number;
  isGap: (v: number | null) => boolean;
};

type SeriesPathsProps = {
  drawn: DrawnLine[];
  unit: string;
};

<<<<<<< HEAD
// DowntimeBands was removed: tinted bands + pill labels were misleading
// (mislabelled provider, alignment artefacts). Gaps in the series line
// now speak for themselves — SeriesPaths renders a natural break wherever
// the underlying values are null.
=======
type DowntimeBandsProps = {
  drawn: DrawnLine[];
  padT: number;
  innerH: number;
};

/** Colored rectangles that highlight the exact window each line was
 *  silent (contiguous gap indices), plus a high-contrast pill label
 *  above each band naming the provider that dropped off. Pills stack
 *  vertically when multiple providers went silent at the same time so
 *  simultaneous outages read as separate lines instead of colliding
 *  as unreadable overlapping text. Rendered under SeriesPaths so the
 *  line stroke stays on top; skipped for excluded (legend-toggled)
 *  providers so their bands disappear with the line. */
export function DowntimeBands({ drawn, padT, innerH }: DowntimeBandsProps) {
  // Collect every band across every visible provider before rendering.
  // Two-pass so we can assign each band a vertical stack slot based on
  // how many EARLIER-placed bands its X-range overlaps — labels then
  // don't collide when three providers went dark in the same window.
  type Band = {
    slug: string;
    name: string;
    color: string;
    x: number;
    w: number;
    slot: number;
  };
  const all: Band[] = [];
  for (const d of drawn) {
    if (d.excluded) continue;
    // Only count gap runs that start AFTER the first observed sample.
    // A leading run of nulls (Prom retention shorter than the visible
    // window, harness started mid-range, or provider added recently)
    // is "we didn't measure yet", not "provider was down for a week".
    // Without this guard the 30D view on aggregator-head-lag rendered
    // a chart-wide band during Prom's initial fill period.
    let seenData = false;
    let runStart: number | null = null;
    const push = (endX: number) => {
      if (runStart == null) return;
      if (!seenData) {
        runStart = null;
        return;
      }
      const startX = d.pts[runStart].x;
      all.push({
        slug: d.slug,
        name: d.name,
        color: d.color,
        x: startX,
        w: Math.max(6, endX - startX),
        slot: 0,
      });
      runStart = null;
    };
    for (let i = 0; i < d.pts.length; i++) {
      const p = d.pts[i];
      if (p.gap) {
        if (runStart == null) runStart = i;
      } else {
        push(d.pts[i].x);
        seenData = true;
      }
    }
    // Trailing gap that runs to the current time — meaningful only
    // when the series had prior data (same seenData guard).
    if (runStart != null) push(d.pts[d.pts.length - 1].x);
  }
  if (all.length === 0) return null;

  // Slot assignment: for each band, pick the smallest slot not used
  // by another band whose X-range overlaps this one. Naive O(n²) is
  // fine — a chart has at most ~20 bands in the pathological case.
  all.sort((a, b) => a.x - b.x);
  for (let i = 0; i < all.length; i++) {
    const b = all[i];
    const used = new Set<number>();
    for (let j = 0; j < i; j++) {
      const p = all[j];
      if (p.x < b.x + b.w && p.x + p.w > b.x) used.add(p.slot);
    }
    let slot = 0;
    while (used.has(slot)) slot++;
    b.slot = slot;
  }

  // Pill geometry constants. Pills sit ABOVE the plot area so they
  // never occlude data. Small padding on the container's padT keeps
  // them within the chart frame.
  const PILL_H = 15;
  const PILL_GAP = 3;

  return (
    <g className="ts-downtime">
      {/* Bands first (behind), then all pills on top so no band tint
          can bleed onto a label from a taller-slot pill. */}
      {all.map((b, i) => (
        <g key={`band-${b.slug}-${i}`}>
          <rect
            x={b.x}
            y={padT}
            width={b.w}
            height={innerH}
            fill={b.color}
            opacity={0.1}
          />
          <line
            x1={b.x}
            x2={b.x}
            y1={padT}
            y2={padT + innerH}
            stroke={b.color}
            strokeWidth={0.8}
            strokeDasharray="3 3"
            opacity={0.55}
          />
          <line
            x1={b.x + b.w}
            x2={b.x + b.w}
            y1={padT}
            y2={padT + innerH}
            stroke={b.color}
            strokeWidth={0.8}
            strokeDasharray="3 3"
            opacity={0.55}
          />
        </g>
      ))}
      {all.map((b, i) => {
        const cx = b.x + b.w / 2;
        // "NAME DATA MISSING" width estimate: ~5.5 px per char plus
        // 14 px of horizontal padding (7 each side). "DATA MISSING"
        // stays neutral: absence of samples could be the provider
        // going down, our harness losing its WebSocket, or a Prom
        // scrape failure — the pill doesn't blame either side.
        const label = `${b.name.toUpperCase()} DATA MISSING`;
        const pillW = Math.max(80, label.length * 5.5 + 14);
        const pillY = padT + 2 + b.slot * (PILL_H + PILL_GAP);
        const pillX = Math.max(0, cx - pillW / 2);
        return (
          <g key={`pill-${b.slug}-${i}`}>
            <rect
              x={pillX}
              y={pillY}
              width={pillW}
              height={PILL_H}
              rx={PILL_H / 2}
              ry={PILL_H / 2}
              fill={b.color}
              opacity={0.95}
            />
            <text
              x={pillX + pillW / 2}
              y={pillY + PILL_H / 2 + 0.5}
              textAnchor="middle"
              dominantBaseline="middle"
              fontFamily="var(--font-sans)"
              fontSize="9.5"
              fontWeight="700"
              letterSpacing="0.06em"
              fill="var(--color-paper, #ffffff)"
            >
              {label}
            </text>
          </g>
        );
      })}
    </g>
  );
}
>>>>>>> origin/main

export function SeriesPaths({ drawn, unit }: SeriesPathsProps) {
  return (
    <>
      {drawn.map((d) => (
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
      ))}
    </>
  );
}

type SeriesGradientsProps = {
  drawn: DrawnLine[];
};

export function SeriesGradients({ drawn }: SeriesGradientsProps) {
  return (
    <>
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
    </>
  );
}

type HoverMarkersProps = {
  drawn: DrawnLine[];
  hoverX: number;
  hoverIdx: number;
  numPoints: number;
  padT: number;
  innerH: number;
  lo: number;
  yRange: number;
};

export function HoverMarkers({
  drawn,
  hoverX,
  hoverIdx,
  numPoints,
  padT,
  innerH,
  lo,
  yRange,
}: HoverMarkersProps) {
  return (
    <>
      {drawn.map((d) => {
        if (d.excluded) return null;
        // Map the global crosshair index to this line's own continuous
        // index AND interpolate Y between bracketing samples so the
        // dot lands exactly on the rendered line at hover-X. Round to
        // nearest sample snapped the dot to a single sample's value,
        // which disagreed visually with the line during steep slopes
        // (the line is drawn as straight SVG segments M…L…L…, so the
        // line's Y at hoverX is lerp(v[N], v[N+1], t) — match it here).
        const globalFraction = numPoints > 1 ? hoverIdx / (numPoints - 1) : 0;
        if (d.values.length === 0) return null;
        const fract = globalFraction * (d.values.length - 1);
        const i0 = Math.floor(fract);
        const i1 = Math.min(i0 + 1, d.values.length - 1);
        const t = fract - i0;
        const v0 = d.values[i0];
        const v1 = d.values[i1];
        // If either bracketing sample is a gap (null bucket included),
        // the line itself is broken here (drawn as `M` not `L`) — skip
        // the dot so we don't paint over a missing segment.
        if (v0 == null || v1 == null) return null;
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
    </>
  );
}
