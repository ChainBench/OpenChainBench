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

type DowntimeBandsProps = {
  drawn: DrawnLine[];
  padT: number;
  innerH: number;
};

/** Colored rectangles that highlight the exact window each line was
 *  silent (contiguous gap indices). Each band tints in the provider's
 *  own color so multiple simultaneous outages read distinctly (e.g.
 *  Codex teal + Mobula orange bands overlapping look like two events,
 *  not one). A small label sits above the band with the provider name
 *  and a short reason so a reader doesn't need to hover the line to
 *  understand who dropped off. Rendered under SeriesPaths so the line
 *  stroke stays on top; skipped for excluded (legend-toggled)
 *  providers so their bands disappear with the line. A single-point
 *  gap still renders (min width 4 px) — a short outage matters just
 *  as much as a long one. */
export function DowntimeBands({ drawn, padT, innerH }: DowntimeBandsProps) {
  return (
    <>
      {drawn.map((d) => {
        if (d.excluded) return null;
        // Collect contiguous gap ranges as [startX, endX] pairs.
        const bands: { x: number; w: number }[] = [];
        let runStart: number | null = null;
        for (let i = 0; i < d.pts.length; i++) {
          const p = d.pts[i];
          if (p.gap) {
            if (runStart == null) runStart = i;
          } else if (runStart != null) {
            const startX = d.pts[runStart].x;
            const endX = d.pts[i].x;
            bands.push({ x: startX, w: Math.max(4, endX - startX) });
            runStart = null;
          }
        }
        // Trailing gap that runs to the current time.
        if (runStart != null) {
          const startX = d.pts[runStart].x;
          const endX = d.pts[d.pts.length - 1].x;
          bands.push({ x: startX, w: Math.max(4, endX - startX) });
        }
        if (bands.length === 0) return null;
        return (
          <g key={`down-${d.slug}`} className="ts-downtime">
            {bands.map((b, i) => {
              // Label only when the band is wide enough that the text
              // fits without overflowing. On narrow bands (1 bucket)
              // the caret above the band carries the meaning alone.
              const cx = b.x + b.w / 2;
              const showLabel = b.w >= 42;
              return (
                <g key={i}>
                  {/* Tinted fill spans the outage window. */}
                  <rect
                    x={b.x}
                    y={padT}
                    width={b.w}
                    height={innerH}
                    fill={d.color}
                    opacity={0.09}
                  />
                  {/* Left + right edges: dashed provider-colored strokes so
                     the boundaries of the outage are unambiguous even
                     when the tint is subtle. */}
                  <line
                    x1={b.x}
                    x2={b.x}
                    y1={padT}
                    y2={padT + innerH}
                    stroke={d.color}
                    strokeWidth={0.8}
                    strokeDasharray="3 3"
                    opacity={0.55}
                  />
                  <line
                    x1={b.x + b.w}
                    x2={b.x + b.w}
                    y1={padT}
                    y2={padT + innerH}
                    stroke={d.color}
                    strokeWidth={0.8}
                    strokeDasharray="3 3"
                    opacity={0.55}
                  />
                  {/* Caret above the band, then the label. The caret
                     alone survives on very narrow bands where the text
                     would be truncated. */}
                  <path
                    d={`M ${(cx - 4).toFixed(2)} ${(padT - 2).toFixed(2)} L ${cx.toFixed(2)} ${(padT + 3).toFixed(2)} L ${(cx + 4).toFixed(2)} ${(padT - 2).toFixed(2)} Z`}
                    fill={d.color}
                    opacity={0.9}
                  />
                  {showLabel && (
                    <text
                      x={cx}
                      y={padT + 14}
                      textAnchor="middle"
                      fontFamily="var(--font-sans)"
                      fontSize="9.5"
                      fontWeight="600"
                      letterSpacing="0.06em"
                      fill={d.color}
                      opacity={0.95}
                    >
                      {d.name.toUpperCase()} · SILENT
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        );
      })}
    </>
  );
}

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
