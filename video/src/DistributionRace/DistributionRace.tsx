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
 * Distribution race — one row per provider with p50/p90/p99 whiskers.
 * Mock data only has a single value series per provider, so we synthesise
 * realistic percentile spreads (~p50, p50*1.45 for p90, p50*2.1 for p99)
 * which approximates the production shape closely enough to validate the
 * motion design. The real composition will receive real percentiles via
 * inputProps.
 *
 * Animation order per row (staggered): p99 bar slams in from the right,
 * p90 ring fades in, p50 dot pops with an overshoot bounce. After all
 * rows are revealed, a final snap-sort hold lets the viewer read the
 * leaderboard.
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
    ? { CHART_LEFT: 400, CHART_RIGHT: width - 64, TOP: 430, ROW_H: 96, LABEL_W: 320 }
    : { CHART_LEFT: 520, CHART_RIGHT: 1820, TOP: 320, ROW_H: 64, LABEL_W: 420 };
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

  // Derive p50/p90/p99 from the current step's value (mock approximation)
  const enriched = bench.providers.map((p) => {
    const p50 = p.values[intIdx];
    return { ...p, p50, p90: p50 * 1.45, p99: p50 * 2.1 };
  });

  // Sort ascending (lower-is-better) for the layout
  const sorted = [...enriched].sort((a, b) =>
    bench.higherIsBetter ? b.p50 - a.p50 : a.p50 - b.p50,
  );

  // Scale axis to cover the longest p99 in the field
  const maxP99 = Math.max(...sorted.map((p) => p.p99));
  const valueToX = (v: number) =>
    CHART_LEFT + ((v / maxP99) * (CHART_RIGHT - CHART_LEFT));

  // Portrait: center the whisker stack in the band between the title and
  // the bottom date zone, sized by the actual provider count.
  const TOP = isPortrait
    ? geom.TOP +
      Math.max(0, Math.floor((height - 560 - geom.TOP - sorted.length * ROW_H) / 2))
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

        const y = TOP + i * ROW_H;
        const x50 = valueToX(p.p50);
        const x90 = valueToX(p.p90);
        const x99 = valueToX(p.p99);

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
                top: y - 18,
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
              <ProviderChip name={p.name} color={p.color} logo={p.logo} size={isPortrait ? 36 : 42} theme={t} />
              <span
                style={{
                  fontSize: isPortrait ? 20 : 24,
                  fontWeight: 700,
                  color: p.color,
                  letterSpacing: "-0.01em",
                }}
              >
                {p.name}
              </span>
            </div>

            {/* The whisker: connector line from p50 → p99 + dot + ring + p99 bar */}
            <svg
              width={width}
              height={ROW_H}
              style={{
                position: "absolute",
                top: y - ROW_H / 2,
                left: 0,
                pointerEvents: "none",
              }}
            >
              {/* Spread band p50 → p99 (low opacity fill) */}
              <rect
                x={x50}
                y={ROW_H / 2 - 8}
                width={Math.max(0, x99 - x50) * rowProgress}
                height={16}
                fill={p.color}
                opacity={0.22}
                rx={8}
              />

              {/* Thick segment p50 → p90 (medium opacity) */}
              <rect
                x={x50}
                y={ROW_H / 2 - 5}
                width={Math.max(0, x90 - x50) * rowProgress}
                height={10}
                fill={p.color}
                opacity={0.55}
                rx={5}
              />

              {/* p90 ring */}
              <circle
                cx={x90}
                cy={ROW_H / 2}
                r={9 * rowProgress}
                fill="none"
                stroke={p.color}
                strokeWidth={2.5}
                opacity={rowProgress}
              />

              {/* p99 vertical bar (the "slam" element) */}
              <rect
                x={x99 - 2}
                y={ROW_H / 2 - 14 * rowProgress}
                width={4}
                height={28 * rowProgress}
                fill={p.color}
                opacity={rowProgress}
                rx={2}
              />

              {/* p50 dot with overshoot + subtle pulse */}
              <circle
                cx={x50}
                cy={ROW_H / 2}
                r={11 * popScale * pulse * rowProgress}
                fill={p.color}
              />
            </svg>

            {/* p50 / p99 numeric labels */}
            <div
              style={{
                position: "absolute",
                top: y + 8,
                left: x50 - 30,
                fontSize: 14,
                color: t.inkFaint,
                fontFamily,
                fontVariantNumeric: "tabular-nums",
                opacity: labelFade,
              }}
            >
              {formatValue(p.p50, bench.unit)}
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
        p50 → p90 → p99
      </div>
      <FilmOverlay />
    </AbsoluteFill>
  );
};

