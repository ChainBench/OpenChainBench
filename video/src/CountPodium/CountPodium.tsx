import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig } from "remotion";
import { loadFont, fontFamily } from "@remotion/google-fonts/InterTight";
import { z } from "zod";
import type { BenchPayload } from "../BarChartRace/mock-data";
import { BenchFrame, stepFloat } from "../lib/bench-frame";
import { themeFor } from "../lib/theme";
import { FilmOverlay, kenBurnsScale } from "../lib/cinematic";
import { easeOutCubic, remap } from "../lib/easing";
import { ProviderChip } from "../lib/provider-chip";
import { LeaderCrown } from "../lib/leader-crown";
import { formatValue } from "../lib/formatters";

loadFont("normal", { weights: ["500", "600", "700", "800"] });

/**
 * Count podium — three vertical bars in podium order (bronze, silver, gold),
 * landing sequentially with an overshoot spring and confetti burst. Below
 * the podium, a receipt of remaining ranks slides in.
 *
 * Best for higher-is-better single-count benches (network coverage, asset
 * coverage). Use MOCK_BENCH_COUNT for the cleanest read.
 */

export const COUNT_PODIUM_DURATION_FRAMES = 510;

export const CountPodiumSchema = z.object({
  theme: z.enum(["light", "dark"]),
  bench: z.any(),
});

export type CountPodiumProps = {
  theme: "light" | "dark";
  bench: BenchPayload;
};

// Podium geometry
// Portrait: podium centered on the full width with its baseline in the
// upper-middle band; the "also tracked" receipt stacks below it instead
// of in a right-hand column.
function podiumGeom(width: number, height: number) {
  const isPortrait = height > width;
  return isPortrait
    ? { BASELINE_Y: 1050, BAR_W: 200, BAR_GAP: 56,
        PODIUM_BAND_LEFT: 0, PODIUM_BAND_W: width,
        RECEIPT_TOP: 1190, RECEIPT_LEFT: 80, RECEIPT_W: width - 160 }
    : { BASELINE_Y: 940, BAR_W: 220, BAR_GAP: 64,
        PODIUM_BAND_LEFT: 80, PODIUM_BAND_W: 1200,
        RECEIPT_TOP: 320, RECEIPT_LEFT: 1280, RECEIPT_W: 560 };
}
export const CountPodium: React.FC<CountPodiumProps> = ({
  theme: mode,
  bench,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const { BASELINE_Y, BAR_W, BAR_GAP, PODIUM_BAND_LEFT, PODIUM_BAND_W, RECEIPT_TOP, RECEIPT_LEFT, RECEIPT_W } = podiumGeom(width, height);
  const t = themeFor(mode);
  const idx = stepFloat(frame, bench.timestamps.length, durationInFrames);
  const intIdx = Math.min(Math.floor(idx), bench.timestamps.length - 1);

  const enriched = bench.providers.map((p) => ({
    ...p,
    value: p.values[intIdx],
  }));
  const sorted = [...enriched].sort((a, b) =>
    bench.higherIsBetter ? b.value - a.value : a.value - b.value,
  );

  const podium = sorted.slice(0, 3); // [1st, 2nd, 3rd]
  const receipt = sorted.slice(3, 8);

  // Landing frames: bronze first, then silver, then gold (drumroll).
  // Proportional to the segment duration so a short race (raceSeconds*30,
  // min 150 frames) still lands all three bars.
  const LAND_BRONZE = Math.round(durationInFrames * 0.25);
  const LAND_SILVER = Math.round(durationInFrames * 0.45);
  const LAND_GOLD = Math.round(durationInFrames * 0.7); // anticipation pause before #1
  const RECEIPT_START = Math.round(durationInFrames * 0.8);

  // Centre the three bars horizontally around 760 (left half of canvas)
  const totalW = 3 * BAR_W + 2 * BAR_GAP;
  const startX = PODIUM_BAND_LEFT + (PODIUM_BAND_W - totalW) / 2;

  // Mapping rank -> visual position. Standard podium = [2nd, 1st, 3rd] left
  // to right (silver-gold-bronze), with gold tallest in the middle.
  const visualOrder = [podium[1], podium[0], podium[2]]; // silver, gold, bronze
  const visualRanks = [1, 0, 2];
  const landFrames = [LAND_SILVER, LAND_GOLD, LAND_BRONZE];

  // Medal accents — gold for #1, silver for #2, bronze for #3.
  const MEDAL_TINT = ["#facc15", "#cbd5e1", "#d97706"]; // by rank 0..2
  const PEDESTAL_LABEL = ["1ST", "2ND", "3RD"];

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

      {/* Podium bars */}
      {visualOrder.map((p, visualIdx) => {
        if (!p) return null;
        const rank = visualRanks[visualIdx];
        const landFrame = landFrames[visualIdx];
        const medal = MEDAL_TINT[rank];

        // Spring growth on landing
        const grow = spring({
          frame: frame - landFrame,
          fps,
          config: { damping: 12, stiffness: 110, mass: 0.9 },
          durationInFrames: 30,
        });

        const finalH = 400 - rank * 80; // gold tallest at 400, silver 320, bronze 240
        const animH = finalH * grow;

        const x = startX + visualIdx * (BAR_W + BAR_GAP);
        const barY = BASELINE_Y - animH;
        const isKing = rank === 0;

        // Count-up of the value while the spring grows
        const countProg = remap(frame, landFrame, landFrame + 30, 0, 1, easeOutCubic);
        const displayValue = p.value * countProg;

        // Screen-shake on landing: 6 frames of decaying 2-3px jitter
        const shakeT = frame - landFrame;
        const shakeActive = shakeT >= 0 && shakeT < 6;
        const shakeDecay = shakeActive ? 1 - shakeT / 6 : 0;
        const shakeX = shakeActive ? Math.sin(shakeT * 2.7) * 2.5 * shakeDecay : 0;
        const shakeY = shakeActive ? Math.cos(shakeT * 3.3) * 3 * shakeDecay : 0;

        return (
          <div
            key={p.slug}
            style={{ transform: `translate(${shakeX}px, ${shakeY}px)` }}
          >
            {/* Crown 👑 floating above the king's chip */}
            {isKing && (
              <LeaderCrown
                frame={frame}
                x={x + BAR_W / 2}
                y={barY - 200}
                revealAt={landFrame + 12}
                size={56}
              />
            )}

            {/* Provider chip + name + value above the bar */}
            <div
              style={{
                position: "absolute",
                top: barY - 158,
                left: x,
                width: BAR_W,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                opacity: grow,
                fontFamily,
              }}
            >
              <ProviderChip name={p.name} color={p.color} logo={p.logo} size={64} theme={t} />
              <div
                style={{
                  fontSize: 26,
                  fontWeight: 700,
                  color: p.color,
                  letterSpacing: "-0.01em",
                }}
              >
                {p.name}
              </div>
              <div
                data-lab-value={formatValue(displayValue, bench.unit)}
                style={{
                  fontSize: 38,
                  fontWeight: 800,
                  color: t.ink,
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: "-0.02em",
                  lineHeight: 1,
                }}
              >
                {formatValue(displayValue, bench.unit)}
              </div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: t.inkMuted,
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  marginTop: 2,
                }}
              >
                {bench.metric}
              </div>
            </div>

            {/* The bar itself — medal accent on top edge for gold/silver/bronze */}
            <div
              style={{
                position: "absolute",
                top: barY,
                left: x,
                width: BAR_W,
                height: animH,
                background: `linear-gradient(180deg, ${p.color} 0%, ${p.color}cc 100%)`,
                borderRadius: "8px 8px 0 0",
                boxShadow: isKing
                  ? `inset 0 6px 0 ${medal}, 0 0 60px ${medal}33`
                  : `inset 0 4px 0 ${medal}`,
              }}
            />

            {/* Pedestal label (1ST / 2ND / 3RD) — medal-tinted */}
            <div
              style={{
                position: "absolute",
                top: BASELINE_Y + 20,
                left: x,
                width: BAR_W,
                textAlign: "center",
                fontSize: 44,
                fontWeight: 800,
                color: medal,
                letterSpacing: "0.04em",
                opacity: grow,
                fontFamily,
              }}
            >
              {PEDESTAL_LABEL[rank]}
            </div>
          </div>
        );
      })}

      {/* Receipt of remaining ranks (right side of canvas) */}
      <div
        style={{
          position: "absolute",
          top: RECEIPT_TOP,
          left: RECEIPT_LEFT,
          width: RECEIPT_W,
          fontFamily,
        }}
      >
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: t.inkFaint,
            marginBottom: 24,
            opacity: remap(frame, RECEIPT_START, RECEIPT_START + 30, 0, 1, easeOutCubic),
          }}
        >
          Also tracked
        </div>
        {receipt.map((p, i) => {
          const slideIn = remap(
            frame,
            RECEIPT_START + 20 + i * 14,
            RECEIPT_START + 50 + i * 14,
            0,
            1,
            easeOutCubic,
          );
          return (
            <div
              key={p.slug}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                height: 56,
                borderBottom: `1px solid ${t.rule}`,
                opacity: slideIn,
                transform: `translateX(${(1 - slideIn) * 20}px)`,
              }}
            >
              <span
                style={{
                  width: 36,
                  fontSize: 18,
                  color: t.inkFaint,
                  fontVariantNumeric: "tabular-nums",
                  fontWeight: 600,
                }}
              >
                {String(i + 4).padStart(2, "0")}
              </span>
              <ProviderChip name={p.name} color={p.color} logo={p.logo} size={36} theme={t} />
              <span
                style={{
                  flex: 1,
                  fontSize: 22,
                  fontWeight: 700,
                  color: p.color,
                  letterSpacing: "-0.01em",
                }}
              >
                {p.name}
              </span>
              <span
                data-lab-value={formatValue(p.value, bench.unit)}
                style={{
                  fontSize: 22,
                  color: t.inkMuted,
                  fontVariantNumeric: "tabular-nums",
                  fontWeight: 600,
                }}
              >
                {formatValue(p.value, bench.unit)}
              </span>
            </div>
          );
        })}
      </div>
      <FilmOverlay />
    </AbsoluteFill>
  );
};

