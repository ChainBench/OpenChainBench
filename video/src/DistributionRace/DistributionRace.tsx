import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont, fontFamily } from "@remotion/google-fonts/InterTight";
import { z } from "zod";
import type { BenchPayload } from "../BarChartRace/mock-data";
import { BenchFrame, stepFloat } from "../lib/bench-frame";
import { themeFor } from "../lib/theme";
import { FilmOverlay, kenBurnsScale } from "../lib/cinematic";
import { easeOutCubic, easeInOutCubic, remap } from "../lib/easing";
import { ProviderChip } from "../lib/provider-chip";
import { LeaderCrown } from "../lib/leader-crown";
import { formatValue } from "../lib/formatters";

loadFont("normal", { weights: ["500", "600", "700", "800"] });

/**
 * Distribution race: one row per provider showing how its published
 * readings spread over the window so far (10th to 90th percentile band,
 * median dot and figure). The payload carries one series per provider,
 * so this is the spread across readings, not a per-request latency
 * distribution, and the legend says so.
 *
 * Rows reveal with a stagger; the median dot pops with an overshoot.
 */

export const DISTRIBUTION_DURATION_FRAMES = 510;

export const DistributionRaceSchema = z.object({
  theme: z.enum(["light", "dark"]),
  bench: z.any(),
});

export type DistributionRaceProps = {
  theme: "light" | "dark";
  bench: BenchPayload;
};

// Portrait squeezes the label column and pushes the whiskers to the right
// edge; rows get taller so the stack fills the 9:16 middle band.
function distGeom(width: number, height: number) {
  const isPortrait = height > width;
  return isPortrait
    ? { CHART_LEFT: 400, CHART_RIGHT: width - 190, TOP: 430, BOTTOM: height - 560, ROW_H: 96, LABEL_W: 320 }
    : { CHART_LEFT: 520, CHART_RIGHT: width - 260, TOP: 320, BOTTOM: 860, ROW_H: 64, LABEL_W: 420 };
}

// Quantile of an ascending array, linear between ranks.
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export const DistributionRace: React.FC<DistributionRaceProps> = ({
  theme: mode,
  bench,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  const isPortrait = height > width;
  const geom = distGeom(width, height);
  const { CHART_LEFT, CHART_RIGHT, ROW_H, LABEL_W } = geom;
  const t = themeFor(mode);
  const idx = stepFloat(frame, bench.timestamps.length, durationInFrames);
  const intIdx = Math.min(Math.floor(idx), bench.timestamps.length - 1);

  // The spread is measured, not modelled: each provider's own published
  // readings so far (one per bucket of the series), 10th percentile to
  // 90th, dot on the median. This view used to invent p90 = p50 x 1.45
  // and p99 = p50 x 2.1 and label them as percentiles.
  const finite = (v: number[]) => v.filter((x) => Number.isFinite(x));
  const enriched = bench.providers.map((p) => {
    const seen = finite(p.values.slice(0, intIdx + 1)).sort((a, b) => a - b);
    return { ...p, lo: quantile(seen, 0.1), med: quantile(seen, 0.5), hi: quantile(seen, 0.9) };
  });

  const sorted = [...enriched].sort((a, b) =>
    bench.higherIsBetter ? b.med - a.med : a.med - b.med,
  );

  // One axis for the whole race (from the full window), so rows never
  // jump as the range fills in. Log when the field spans more than 30x:
  // a linear axis put nineteen of twenty chains' fees on the same pixel.
  const all = finite(bench.providers.flatMap((p) => p.values));
  const axisMin = Math.max(Math.min(...all), 1e-12);
  const axisMax = Math.max(...all);
  const useLog = axisMax / axisMin > 30;
  const valueToX = (v: number) => {
    const f = useLog
      ? (Math.log10(Math.max(v, axisMin)) - Math.log10(axisMin)) / Math.max(1e-9, Math.log10(axisMax) - Math.log10(axisMin))
      : (v - Math.min(0, axisMin)) / Math.max(1e-12, axisMax - Math.min(0, axisMin));
    return CHART_LEFT + Math.max(0, Math.min(1, f)) * (CHART_RIGHT - CHART_LEFT);
  };

  // Rows shrink to fit: twenty chains at 64px ran 400px past the frame.
  const rowH = Math.min(ROW_H, Math.floor((geom.BOTTOM - geom.TOP) / Math.max(1, sorted.length)));
  const compact = rowH < 52;
  const chip = compact ? Math.max(24, rowH - 10) : isPortrait ? 36 : 42;
  const nameSize = compact ? 19 : isPortrait ? 20 : 24;

  // Portrait: center the whisker stack in the band between the title and
  // the bottom date zone, sized by the actual provider count.
  const TOP = isPortrait
    ? geom.TOP +
      Math.max(0, Math.floor((geom.BOTTOM - geom.TOP - sorted.length * rowH) / 2))
    : geom.TOP;

  // Row entrance stagger: each row starts 8 frames after the previous one
  const ROW_STAGGER = 8;
  const REVEAL_FRAMES = 24;

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

      {/* 👑 Crown above the leader row (sorted[0]). */}
      <LeaderCrown frame={frame} x={isPortrait ? 200 : 260} y={TOP - 48} revealAt={30} size={42} />

      {sorted.map((p, i) => {
        const rowStart = 30 + i * ROW_STAGGER;
        const rowProgress = remap(frame, rowStart, rowStart + REVEAL_FRAMES, 0, 1, easeOutCubic);
        const popProgress = remap(frame, rowStart + 12, rowStart + REVEAL_FRAMES, 0, 1, easeInOutCubic);
        if (rowProgress <= 0) return null;

        const y = TOP + i * rowH + rowH / 2;
        const xLo = valueToX(p.lo);
        const xMed = valueToX(p.med);
        const xHi = valueToX(p.hi);

        // Bar overshoot for the p50 dot
        const popScale = popProgress < 1 ? 1 + (1 - popProgress) * 0.4 : 1;

        // Subtle continuous pulse of the p50 dot (±8%), phase-shifted per row
        const pulse = 1 + 0.08 * Math.sin((frame - rowStart) * 0.22 + i * 0.9);

        // p50 numeric label appears ~6 frames after the dot pop completes
        const labelFade = remap(
          frame,
          rowStart + REVEAL_FRAMES + 6,
          rowStart + REVEAL_FRAMES + 18,
          0,
          1,
          easeOutCubic,
        );

        return (
          <div key={p.slug}>
            {/* Rank + provider chip + name */}
            <div
              style={{
                position: "absolute",
                top: y - chip / 2,
                left: isPortrait ? 56 : 80,
                width: LABEL_W,
                display: "flex",
                alignItems: "center",
                gap: 14,
                fontFamily,
                opacity: rowProgress,
              }}
            >
              <span
                style={{
                  width: 32,
                  fontSize: 18,
                  color: t.inkFaint,
                  fontVariantNumeric: "tabular-nums",
                  textAlign: "right",
                  fontWeight: 600,
                }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <ProviderChip name={p.name} color={p.color} logo={p.logo} size={chip} theme={t} />
              <span
                style={{
                  fontSize: nameSize,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  fontWeight: 700,
                  color: p.color,
                  letterSpacing: "-0.01em",
                }}
              >
                {p.name}
              </span>
            </div>

            {/* Measured spread: 10th to 90th percentile band, median dot. */}
            <svg
              width={width}
              height={rowH}
              style={{
                position: "absolute",
                top: y - rowH / 2,
                left: 0,
                pointerEvents: "none",
              }}
            >
              <line x1={CHART_LEFT} x2={CHART_RIGHT} y1={rowH / 2} y2={rowH / 2} stroke={t.rule} strokeWidth={1} opacity={0.6} />
              <rect
                x={xLo}
                y={rowH / 2 - 7}
                width={Math.max(4, (xHi - xLo) * rowProgress)}
                height={14}
                fill={p.color}
                opacity={0.4}
                rx={7}
              />
              <circle
                cx={xMed}
                cy={rowH / 2}
                r={Math.min(11, rowH / 4) * popScale * pulse * rowProgress}
                fill={p.color}
                stroke={t.background}
                strokeWidth={2}
              />
            </svg>

            {/* Median value, right of the chart so it never sits on a band */}
            <div
              data-lab-value={formatValue(p.med, bench.unit)}
              style={{
                position: "absolute",
                top: y - 13,
                left: CHART_RIGHT + 28,
                fontSize: 22,
                fontWeight: 700,
                color: t.ink,
                fontFamily,
                fontVariantNumeric: "tabular-nums",
                opacity: labelFade,
                whiteSpace: "nowrap",
              }}
            >
              {formatValue(p.med, bench.unit)}
            </div>
          </div>
        );
      })}

      {/* Axis tick legend in the bottom-right of the chart area */}
      <div
        style={{
          position: "absolute",
          top: TOP - 40,
          left: CHART_LEFT,
          fontSize: 14,
          color: t.inkFaint,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          fontWeight: 600,
          fontFamily,
        }}
      >
        Spread of readings so far · bar = 10th to 90th percentile · dot and figure = median{useLog ? " · log scale" : ""}
      </div>
      <FilmOverlay />
    </AbsoluteFill>
  );
};

