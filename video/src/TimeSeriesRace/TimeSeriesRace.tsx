import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont, fontFamily } from "@remotion/google-fonts/InterTight";
import { z } from "zod";
import type { BenchPayload } from "../BarChartRace/mock-data";
import { BenchFrame, stepFloat } from "../lib/bench-frame";
import { themeFor } from "../lib/theme";
import { FilmOverlay, kenBurnsScale } from "../lib/cinematic";
import { computeLeadChanges, BeatBanner } from "../lib/beats";
import { easeOutCubic, remap } from "../lib/easing";
import { formatValue, formatTick, unitAxisLabel } from "../lib/formatters";
import { ProviderChip } from "../lib/provider-chip";
import { CrownIcon } from "../lib/leader-crown";

loadFont("normal", { weights: ["500", "600", "700", "800"] });

/**
 * Multi-line race. Each provider's line draws left-to-right across the
 * chart canvas at the same rate. A small "head dot" follows the front of
 * each line so the eye tracks the current value. End-of-line labels stay
 * pinned to the right gutter once the line completes.
 *
 * The leader pill at top-right snaps to whichever provider currently sits
 * at the front; an overtake gets a brief highlight flash (~12 f) so the
 * viewer notices the rank flip without needing to read the lines.
 *
 * Y scale is adaptive: when providers span more than ~1.3 orders of
 * magnitude (e.g. one at 15 s, two at 800 ms), a linear axis crushes the
 * fast providers into a 2-px band at the bottom. In that case we switch
 * to a log10 axis with 1/2/5-per-decade ticks so every line stays
 * readable. Otherwise the familiar linear axis is kept.
 */

export const TIME_SERIES_DURATION_FRAMES = 510;

export const TimeSeriesRaceSchema = z.object({
  theme: z.enum(["light", "dark"]),
  beats: z.boolean().optional(),
  bench: z.any(),
});

export type TimeSeriesRaceProps = {
  theme: "light" | "dark";
  bench: BenchPayload;
  beats?: boolean;
};

// Chart geometry. Landscape keeps the historical 1920x1080 numbers;
// portrait (Short 9:16) squares the plot between the title block and the
// bottom date/source zone so the canvas has no dead band.
function chartGeom(width: number, height: number, names: string[]) {
  const isPortrait = height > width;
  // The right gutter holds the end-of-line labels (gap, 36px chip, 10px,
  // name, value). It was a fixed 100px in landscape, so every name longer than
  // about four letters ran off the frame at the end of the race. Inter
  // Tight 700 at 20px averages ~0.56em per character.
  const longest = Math.max(4, ...names.map((n) => n.length));
  // Plus the value after the name ("1051 ms", 18px).
  const gutter = 14 + 36 + 10 + Math.ceil(longest * 20 * 0.56) + 10 + 80 + (isPortrait ? 32 : 56);
  return isPortrait
    ? {
        CHART_LEFT: 130, // Y-axis labels gutter
        CHART_RIGHT: width - Math.max(210, gutter),
        CHART_TOP: 430,
        CHART_BOTTOM: height - 620, // X-axis labels + date zone below
      }
    : { CHART_LEFT: 160, CHART_RIGHT: width - Math.max(100, gutter), CHART_TOP: 320, CHART_BOTTOM: 860 };
}


export const TimeSeriesRace: React.FC<TimeSeriesRaceProps> = ({
  theme: mode,
  bench,
  beats,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  const isPortrait = height > width;
  const { CHART_LEFT, CHART_RIGHT, CHART_TOP, CHART_BOTTOM } = chartGeom(width, height, bench.providers.map((p) => p.name));
  const t = themeFor(mode);
  const idx = stepFloat(frame, bench.timestamps.length, durationInFrames);

  // ── Y-axis scale (shared across all providers) ──────────────────────
  // Linear when values live in the same order of magnitude; log10 when
  // max/min > ~20 so slow outliers don't flatten everyone else.
  const allValues = bench.providers.flatMap((p) => p.values);
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  // ~20× spread = mixed orders of magnitude. Threshold sits at 15 so the
  // canonical bug case (800 ms vs 15 000 ms, ratio 18.75) flips to log.
  const useLog = rawMin > 0 && rawMax / rawMin > 15;

  let yMin: number;
  let yMax: number;
  if (useLog) {
    // Pad ~6% of the log span on each side so lines never touch edges.
    const logMin = Math.log10(rawMin);
    const logMax = Math.log10(rawMax);
    const pad = Math.max(0.04, (logMax - logMin) * 0.06);
    yMin = Math.pow(10, logMin - pad);
    yMax = Math.pow(10, logMax + pad);
  } else {
    yMin = rawMin * 0.9;
    yMax = rawMax * 1.05;
  }

  const chartW = CHART_RIGHT - CHART_LEFT;
  const chartH = CHART_BOTTOM - CHART_TOP;

  // Single value→pixel mapper used by lines, dots, grid and badges so
  // nothing can disagree about where a value sits.
  const logYMin = useLog ? Math.log10(yMin) : 0;
  const logYMax = useLog ? Math.log10(yMax) : 1;
  const yPos = (v: number): number => {
    if (useLog) {
      const safe = Math.max(v, yMin);
      const frac = (Math.log10(safe) - logYMin) / (logYMax - logYMin);
      return CHART_TOP + chartH * (1 - frac);
    }
    return CHART_TOP + chartH * (1 - (v - yMin) / (yMax - yMin));
  };

  const yTicks = useLog ? logNiceTicks(yMin, yMax) : niceTicks(yMin, yMax, 5);

  // Find current leader (lowest value for lower-is-better) at this step
  const intIdx = Math.min(Math.floor(idx), bench.timestamps.length - 1);
  const sortedByCurrent = [...bench.providers].sort((a, c) =>
    bench.higherIsBetter
      ? c.values[intIdx] - a.values[intIdx]
      : a.values[intIdx] - c.values[intIdx],
  );
  const leader = sortedByCurrent[0];

  // Per-line entrance fade so lines materialise rather than blinking in
  const lineFade = remap(frame, 0, 15, 0, 1, easeOutCubic);

  // Shared helpers: head position + full path for a provider at the
  // current step. Captured here so the line render, the head dot, and
  // the floating chip stay perfectly in sync (no risk of one being a
  // frame off from another).
  const headFor = (p: (typeof bench.providers)[number], at: number) => {
    const lastInt = Math.floor(at);
    if (lastInt < 0) return null;
    const frac = at - lastInt;
    if (frac > 0 && lastInt < bench.timestamps.length - 1) {
      const v0 = p.values[lastInt];
      const v1 = p.values[lastInt + 1];
      const v = v0 + (v1 - v0) * frac;
      const x = CHART_LEFT + ((lastInt + frac) / (bench.timestamps.length - 1)) * chartW;
      return { x, y: yPos(v) };
    }
    const v = p.values[lastInt];
    const x = CHART_LEFT + (lastInt / (bench.timestamps.length - 1)) * chartW;
    return { x, y: yPos(v) };
  };

  const pathFor = (p: (typeof bench.providers)[number], at: number): string => {
    const segs: string[] = [];
    for (let i = 0; i <= Math.floor(at); i++) {
      const x = CHART_LEFT + (i / (bench.timestamps.length - 1)) * chartW;
      const y = yPos(p.values[i]);
      segs.push(`${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    const lastInt = Math.floor(at);
    const frac = at - lastInt;
    if (frac > 0 && lastInt < bench.timestamps.length - 1) {
      const v0 = p.values[lastInt];
      const v1 = p.values[lastInt + 1];
      const v = v0 + (v1 - v0) * frac;
      const x = CHART_LEFT + ((lastInt + frac) / (bench.timestamps.length - 1)) * chartW;
      segs.push(`L ${x.toFixed(2)} ${yPos(v).toFixed(2)}`);
    }
    return segs.join(" ");
  };

  // Value at the cursor, interpolated like the head dot, for the label.
  const valueAt = (p: (typeof bench.providers)[number], at: number): number => {
    const i = Math.max(0, Math.min(Math.floor(at), bench.timestamps.length - 1));
    const frac = at - i;
    if (frac > 0 && i < bench.timestamps.length - 1) return p.values[i] + (p.values[i + 1] - p.values[i]) * frac;
    return p.values[i];
  };

  // Label stack: 56px pitch when there is room; tighter, with a smaller
  // chip and name, when 10+ providers share the chart height (rpc-cluster
  // had twelve labels on 540px and they sat on top of each other).
  const labelRoom = CHART_BOTTOM - CHART_TOP - 16;
  const pitch = Math.max(30, Math.min(56, labelRoom / Math.max(1, bench.providers.length - 1)));
  const chipSize = pitch >= 48 ? 36 : 26;
  const nameSize = pitch >= 48 ? 20 : 17;

  return (
    <AbsoluteFill
      style={{
        background: t.background,
        fontFamily,
        transform: `scale(${kenBurnsScale(frame, durationInFrames)})`,
      }}
    >
      <BenchFrame
        bench={bench}
        theme={t}
        stepFloat={idx}
        totalFrames={durationInFrames}
      />

      {/* Y-axis tick labels + horizontal gridlines aligned to them.
          Linear → niceTicks() round values; log → 1/2/5-per-decade so the
          axis reads 500ms / 1s / 2s / 5s / 10s instead of crushing the
          fast providers into the bottom 2px. */}
      <svg
        width={width}
        height={height}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        {/* Axis caption: what the tick numbers measure. Sits on top of
            the Y gutter so a viewer never has to guess the unit. */}
        {/* Left-aligned on the frame margin: right-aligned on the gutter,
            "MILLISECONDS" started 19px off the left edge in 9:16. */}
        <text
          x={isPortrait ? 56 : 80}
          y={CHART_TOP - 20}
          textAnchor="start"
          fill={t.inkFaint}
          fontFamily={fontFamily}
          fontSize={14}
          fontWeight={700}
          letterSpacing="0.12em"
          opacity={lineFade * 0.85}
        >
          {unitAxisLabel(bench.unit).toUpperCase()}
        </text>
        {yTicks.map((tickValue) => {
          const y = yPos(tickValue);
          return (
            <g key={tickValue} opacity={lineFade * 0.7}>
              <line
                x1={CHART_LEFT}
                x2={CHART_RIGHT}
                y1={y}
                y2={y}
                stroke={t.rule}
                strokeWidth={1}
                strokeDasharray="4 8"
              />
              <text
                x={CHART_LEFT - 16}
                y={y + 5}
                textAnchor="end"
                fill={t.inkFaint}
                fontFamily={fontFamily}
                fontSize={16}
                fontWeight={600}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {formatTick(tickValue, bench.unit)}
              </text>
            </g>
          );
        })}

        {/* Solid baseline so the plot has a visual floor even when the
            lowest gridline lands above CHART_BOTTOM. */}
        <line
          x1={CHART_LEFT}
          x2={CHART_RIGHT}
          y1={CHART_BOTTOM}
          y2={CHART_BOTTOM}
          stroke={t.rule}
          strokeWidth={1.5}
          opacity={lineFade * 0.9}
        />

        {/* X-axis date labels — 5 evenly spaced, formatted DD Mon */}
        {dateTicks(bench.timestamps, 5).map(({ ts, frac }) => {
          const x = CHART_LEFT + frac * chartW;
          return (
            <g key={ts} opacity={lineFade * 0.7}>
              <line
                x1={x}
                x2={x}
                y1={CHART_BOTTOM}
                y2={CHART_BOTTOM + 6}
                stroke={t.inkFaint}
                strokeWidth={1}
              />
              <text
                x={x}
                y={CHART_BOTTOM + 26}
                textAnchor="middle"
                fill={t.inkFaint}
                fontFamily={fontFamily}
                fontSize={15}
                fontWeight={600}
              >
                {formatDateShort(ts)}
              </text>
            </g>
          );
        })}

        {/* Each line drawn as a polyline up to the current step. Leader
            gets a slightly heavier stroke; head dot pulses gently. */}
        {bench.providers.map((p) => {
          const head = headFor(p, idx);
          if (!head) return null;
          const path = pathFor(p, idx);
          const isLeader = p.slug === leader.slug;
          const pulse = 1 + Math.sin(frame * 0.22) * 0.18;
          return (
            <g key={p.slug} opacity={lineFade}>
              <path
                d={path}
                fill="none"
                stroke={p.color}
                strokeWidth={isLeader ? 4.5 : 3.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* Head dot — sits behind the chip but visible as a small pulse */}
              <circle
                cx={head.x}
                cy={head.y}
                r={6 * pulse}
                fill={p.color}
                stroke={t.background}
                strokeWidth={2}
              />
            </g>
          );
        })}
      </svg>

      {/*
        End-of-line provider chips + names. They now FOLLOW each line's
        head dot — riding along with the X cursor as it sweeps right. A
        post-pass pushes overlapping chips apart on Y so a tight cluster
        of leaders stays legible, then clamps the stack back inside the
        chart so no label ever leaves the canvas. Drop shadow keeps each
        name readable against whichever line colour it briefly crosses.
       */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {placeLabels(bench.providers, idx, headFor, CHART_TOP + 8, CHART_BOTTOM - 8, pitch).map(
          ({ p, x, y, anchorY }) => (
            <div
              key={p.slug}
              style={{
                position: "absolute",
                left: x + 14,
                top: y - 18,
                display: "flex",
                alignItems: "center",
                gap: 10,
                opacity: lineFade,
                fontFamily,
                willChange: "transform",
              }}
            >
              {/* Dashed leader from head dot to chip — only when the
                  collision pass moved the chip by more than ~half its
                  height. Smaller shifts produced short stub-lines that
                  looked like random artefacts above the chips. */}
              {Math.abs(y - anchorY) > 24 && (
                <svg
                  width={1}
                  height={Math.abs(y - anchorY)}
                  style={{
                    position: "absolute",
                    left: -10,
                    top: anchorY < y ? -(y - anchorY) + 18 : 18,
                    pointerEvents: "none",
                  }}
                >
                  <line
                    x1={0}
                    x2={0}
                    y1={0}
                    y2={Math.abs(y - anchorY)}
                    stroke={p.color}
                    strokeWidth={1.5}
                    strokeDasharray="2 4"
                    opacity={0.5}
                  />
                </svg>
              )}
              <ProviderChip name={p.name} color={p.color} logo={p.logo} size={chipSize} theme={t} />
              <span
                style={{
                  fontSize: nameSize,
                  fontWeight: 700,
                  color: p.color,
                  letterSpacing: "-0.01em",
                  textShadow: `0 0 8px ${t.background}, 0 0 14px ${t.background}`,
                }}
              >
                {p.name}
              </span>
              <span
                data-lab-value={formatValue(valueAt(p, idx), bench.unit)}
                style={{
                  fontSize: nameSize - 2,
                  fontWeight: 600,
                  color: t.inkMuted,
                  fontVariantNumeric: "tabular-nums",
                  textShadow: `0 0 8px ${t.background}, 0 0 14px ${t.background}`,
                }}
              >
                {formatValue(valueAt(p, idx), bench.unit)}
              </span>
            </div>
          ),
        )}
      </div>

      {/* No floating crown here: the pill names the leader, and a crown
          above the leader's head dot landed on the next label down. */}
      {/* Leader pill (top-right under wordmark) */}
      <div
        style={{
          position: "absolute",
          top: isPortrait ? 320 : 180,
          right: isPortrait ? 56 : 80,
          background: leader.color,
          color: "#000000",
          padding: "10px 18px",
          borderRadius: 999,
          fontSize: 16,
          fontWeight: 700,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          opacity: lineFade,
          fontFamily,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <CrownIcon size={18} color="#000000" />
        Leader · {leader.name}
      </div>
      {(beats ? computeLeadChanges(bench) : []).map((b) => (
        <BeatBanner key={b.step} beat={b} stepFloat={idx} isPortrait={isPortrait} />
      ))}
      <FilmOverlay />
    </AbsoluteFill>
  );
};

/**
 * Compute a small set of "nice" round numbers within [min, max] suitable
 * for axis tick labels. Rounds to the nearest power-of-10 step that fits
 * 3-6 ticks. Mirrors the pattern used by D3.scaleLinear().ticks().
 */
function niceTicks(min: number, max: number, target = 5): number[] {
  if (max <= min) return [min];
  const range = max - min;
  const rawStep = range / target;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * magnitude);
  const step = candidates.find((s) => range / s <= target * 1.4) ?? candidates[candidates.length - 1];
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) {
    out.push(Number(v.toFixed(6)));
  }
  return out;
}

/**
 * Log-scale tick values: 1/2/5 multiples of each decade within
 * [min, max] (D3 scaleLog convention). If the range spans many decades
 * the 1/2/5 set gets crowded, so we progressively thin to powers of 10,
 * then to every other power, keeping 3-7 labelled gridlines.
 */
function logNiceTicks(min: number, max: number): number[] {
  if (!(min > 0) || max <= min) return [min];
  const dLo = Math.floor(Math.log10(min));
  const dHi = Math.ceil(Math.log10(max));
  let ticks: number[] = [];
  for (let d = dLo; d <= dHi; d++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, d);
      if (v >= min && v <= max) ticks.push(v);
    }
  }
  if (ticks.length > 7) {
    const powersOnly = ticks.filter((v) => {
      const l = Math.log10(v);
      return Math.abs(l - Math.round(l)) < 1e-9;
    });
    if (powersOnly.length >= 3) ticks = powersOnly;
  }
  if (ticks.length > 7) {
    ticks = ticks.filter((_, i) => i % 2 === 0);
  }
  return ticks.length > 0 ? ticks : [min, max];
}

/** Pick N evenly-spaced timestamps from the array for X-axis ticks. */
function dateTicks(timestamps: number[], target = 5): { ts: number; frac: number }[] {
  if (timestamps.length === 0) return [];
  const out: { ts: number; frac: number }[] = [];
  for (let i = 0; i < target; i++) {
    const frac = i / (target - 1);
    const idx = Math.round(frac * (timestamps.length - 1));
    out.push({ ts: timestamps[idx], frac });
  }
  return out;
}

function formatDateShort(ts: number): string {
  const d = new Date(ts);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

/**
 * Place each line's chip + name beside its current head dot, then push
 * vertically-overlapping labels apart so they all stay readable when a
 * cluster of providers converges. Greedy sweep top-to-bottom, then a
 * bottom-up clamp pass so the stack never escapes [minY, maxY] (labels
 * used to get pushed below CHART_BOTTOM when a slow outlier compressed
 * everyone else against the floor).
 *
 * Returns the original anchored Y as well so the caller can draw a
 * subtle dashed leader line from the chip to its true head when the
 * collision pass shifted the chip away from it.
 */
function placeLabels<P extends { slug: string }>(
  providers: P[],
  at: number,
  headFor: (p: P, at: number) => { x: number; y: number } | null,
  minY: number = -Infinity,
  maxY: number = Infinity,
  spacing: number = 56,
): { p: P; x: number; y: number; anchorY: number }[] {
  // Chip is 36px tall; text label sits next to it. 56px = chip + ~20px
  // breathing room so vertically stacked chips don't crowd each other
  // when 4-5 providers cluster at similar y (e.g. bottom of the chart
  // when fees / latency all converge close to zero).
  const MIN_SPACING = spacing;
  const placed: { p: P; x: number; y: number; anchorY: number }[] = [];
  for (const p of providers) {
    const head = headFor(p, at);
    if (!head) continue;
    placed.push({ p, x: head.x, y: head.y, anchorY: head.y });
  }
  placed.sort((a, b) => a.y - b.y);
  // Downward pass: resolve overlaps.
  for (let i = 1; i < placed.length; i++) {
    const prev = placed[i - 1];
    const cur = placed[i];
    if (cur.y < prev.y + MIN_SPACING) {
      cur.y = prev.y + MIN_SPACING;
    }
  }
  // Bottom-up clamp: keep the whole stack on the canvas.
  if (placed.length > 0) {
    const last = placed[placed.length - 1];
    if (last.y > maxY) last.y = maxY;
    for (let i = placed.length - 2; i >= 0; i--) {
      if (placed[i].y > placed[i + 1].y - MIN_SPACING) {
        placed[i].y = placed[i + 1].y - MIN_SPACING;
      }
    }
    // If the upward pass overshot the top, nudge back down within the
    // available room (degenerate case: more labels than vertical space).
    if (placed[0].y < minY) {
      const shift = minY - placed[0].y;
      const room = maxY - placed[placed.length - 1].y;
      const apply = Math.min(shift, Math.max(0, room));
      for (const item of placed) item.y += apply;
    }
  }
  return placed;
}
