import { CrownIcon } from "../lib/leader-crown";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from "remotion";
import { loadFont, fontFamily } from "@remotion/google-fonts/InterTight";
import { z } from "zod";
import type { BenchPayload } from "../BarChartRace/mock-data";
import { themeFor } from "../lib/theme";
import { FilmOverlay } from "../lib/cinematic";
import { easeOutCubic, remap } from "../lib/easing";
import { ProviderChip } from "../lib/provider-chip";
import {
  computeWinnerStats,
  fmtSpan,
  timestampStepMs,
} from "../lib/winner-stats";

loadFont("normal", { weights: ["500", "600", "700", "800"] });

/**
 * Results board — the "winner breakdown" frame that plays right before
 * the outro. Lists every provider that held #1 at least once across the
 * timeline with "Mobula · winner for 18 days" + a proportional bar.
 *
 * Duration: 3s (90 frames @ 30fps). Reveal staggered top-to-bottom so
 * the eye can track each row as it lands.
 */

export const RESULTS_BOARD_DURATION_FRAMES = 150;

export const ResultsBoardSchema = z.object({
  theme: z.enum(["light", "dark"]),
  bench: z.any(),
});

export type ResultsBoardProps = {
  theme: "light" | "dark";
  bench: BenchPayload;
};

export const ResultsBoard: React.FC<ResultsBoardProps> = ({ theme: mode, bench }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  // Portrait: full-width rows and a lower start so the board fills the
  // 9:16 canvas instead of floating in the top half.
  const isPortrait = height > width;
  const t = themeFor(mode);

  const stats = computeWinnerStats(bench);
  const stepMs = timestampStepMs(bench);
  // The window spans first to last reading. Counting every reading as a
  // full step said "30.5 days tracked" for a 30-day series.
  const spanMs =
    bench.timestamps.length > 1
      ? bench.timestamps[bench.timestamps.length - 1] - bench.timestamps[0]
      : stepMs;
  const maxCount = stats[0]?.count ?? 1;

  const headerOpacity = remap(frame, 0, 18, 0, 1, easeOutCubic);
  const eyebrowOpacity = remap(frame, 6, 24, 0, 1, easeOutCubic);

  // Portrait: center the row block vertically inside the band between
  // the title zone and the bottom footer, sized by the ACTUAL number of
  // rows (same pattern as BarChartRace's layoutFor) so a 2-winner board
  // doesn't float in the top half of the 9:16 canvas.
  const rowsN = Math.min(6, stats.length);
  const ROW_H = 104; // row height 90 + marginBottom 14
  const bandTop = 420;
  const bandBottom = height - 360;
  const rowsTop = isPortrait
    ? bandTop + Math.max(0, Math.floor((bandBottom - bandTop - rowsN * ROW_H) / 2))
    : 320;

  return (
    <AbsoluteFill style={{ background: t.background, fontFamily }}>
      {/* Eyebrow */}
      <div
        style={{
          position: "absolute",
          top: isPortrait ? 150 : 110,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: "0.32em",
          textTransform: "uppercase",
          color: t.inkFaint,
          opacity: eyebrowOpacity,
        }}
      >
        Leaderboard · {fmtSpan(spanMs)} tracked
      </div>

      {/* Title */}
      <div
        style={{
          position: "absolute",
          top: isPortrait ? 210 : 160,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 72,
          fontWeight: 800,
          letterSpacing: "-0.03em",
          color: t.ink,
          opacity: headerOpacity,
        }}
      >
        Who held #1
      </div>

      {/* Rows */}
      <div
        style={{
          position: "absolute",
          top: rowsTop,
          left: isPortrait ? 64 : 240,
          right: isPortrait ? 64 : 240,
        }}
      >
        {stats.slice(0, 6).map((s, i) => {
          const enter = spring({
            frame: frame - 24 - i * 10,
            fps,
            config: { damping: 14, stiffness: 130, mass: 0.9 },
            durationInFrames: 30,
          });
          const isLeader = i === 0;
          const barFill = remap(frame, 36 + i * 10, 78 + i * 10, 0, 1, easeOutCubic);
          // Softer reveal: the track + gradient fill fade in ahead of the
          // width sweep so the bar doesn't pop into an empty row.
          const fillFade = remap(frame, 30 + i * 10, 54 + i * 10, 0, 1, easeOutCubic);

          return (
            <div
              key={s.slug}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 22,
                height: 90,
                marginBottom: 14,
                opacity: enter,
                transform: `translateX(${(1 - enter) * 32}px)`,
              }}
            >
              {/* Crown / rank */}
              <div
                style={{
                  width: 60,
                  fontSize: isLeader ? 44 : 26,
                  fontWeight: 800,
                  color: isLeader ? "#facc15" : t.inkFaint,
                  textAlign: "center",
                  lineHeight: 1,
                  fontVariantNumeric: "tabular-nums",
                  display: "flex",
                  justifyContent: "center",
                }}
              >
                {isLeader ? <CrownIcon size={40} /> : String(i + 1).padStart(2, "0")}
              </div>

              {/* Logo */}
              <ProviderChip
                name={s.name}
                color={s.color}
                logo={s.logo}
                size={62}
                theme={t}
              />

              {/* Name + label */}
              <div style={{ minWidth: 280 }}>
                <div
                  style={{
                    fontSize: 36,
                    fontWeight: 800,
                    color: t.ink,
                    letterSpacing: "-0.02em",
                    lineHeight: 1.1,
                  }}
                >
                  {s.name}
                </div>
                <div
                  style={{
                    fontSize: 18,
                    fontWeight: 600,
                    color: s.color,
                    letterSpacing: "0.04em",
                    marginTop: 4,
                    textTransform: "uppercase",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  Winner for {fmtSpan(s.share * spanMs)}
                </div>
              </div>

              {/* Proportional bar */}
              <div
                style={{
                  flex: 1,
                  height: 18,
                  background: t.rule,
                  borderRadius: 9,
                  overflow: "hidden",
                  position: "relative",
                  opacity: fillFade,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: `${(s.count / maxCount) * 100 * barFill}%`,
                    background: `linear-gradient(90deg, ${s.color}cc 0%, ${s.color} 100%)`,
                    borderRadius: 9,
                    opacity: fillFade,
                  }}
                />
              </div>

              {/* Share of the window in the lead. The raw reading count
                  ("61") meant nothing to a viewer. */}
              <div
                style={{
                  width: 110,
                  textAlign: "right",
                  fontSize: 32,
                  fontWeight: 800,
                  color: t.ink,
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: "-0.01em",
                }}
              >
                {Math.round(s.share * 100)}%
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div
        style={{
          position: "absolute",
          bottom: isPortrait ? 140 : 64,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 18,
          fontWeight: 600,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: t.inkMuted,
          opacity: remap(frame, 50, 80, 0, 1, easeOutCubic),
        }}
      >
        openchainbench.com / {bench.slug}
      </div>
      <FilmOverlay />
    </AbsoluteFill>
  );
};
