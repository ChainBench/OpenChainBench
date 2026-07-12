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
