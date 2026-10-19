import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont, fontFamily } from "@remotion/google-fonts/InterTight";
import { z } from "zod";
import type { BenchPayload, ProviderSeries } from "./mock-data";
import { easeOutCubic, easeInOutCubic, remap, lerp } from "../lib/easing";
import { ProviderChip } from "../lib/provider-chip";
import { themeFor } from "../lib/theme";
import { FilmOverlay, kenBurnsScale } from "../lib/cinematic";
import { computeLeadChanges, BeatBanner } from "../lib/beats";
import { LeaderCrown } from "../lib/leader-crown";
import { formatValue } from "../lib/formatters";
import { RollingNumber } from "../lib/rolling-number";

loadFont("normal", { weights: ["500", "600", "700", "800"] });

/**
 * 17-second bar chart race driven entirely by `inputProps.bench`. Same
 * composition serves every benchmark; the API route in OpenChainBench
 * will fetch the right series and pass them in.
 *
 *  Frame budget @ 30 fps (total 510):
 *   0-15    title + scaffolding fade in
 *  15-450   race body — one timestamp step every `framesPerStep` frames
 * 450-510   hold on final ranking + outro text
 *
 * Motion design choices (from the deepthink brief):
 *   - top 8 visible, smooth swap-in / swap-out
 *   - 0.5s per data point at 30 fps -> 15 frames per step
 *   - rank order eased with cubic in-out so swaps feel deliberate
 *   - bar value labels animate the number too, not just the width
 */

const HEAD_FRAMES = 15;
const TAIL_FRAMES = 60;
const VISIBLE_BARS = 8;

/**
 * Legacy export — kept for the Composition entry's `defaultProps` so the
 * Remotion Studio still has a sane default. Actual render duration is
 * computed dynamically via `raceDurationFor("BarChartRace", N, speed)`
 * from `src/lib/speed.ts` and resolved through `calculateMetadata`.
 */
export const BAR_RACE_DURATION_FRAMES = 510;

export const BarChartRaceSchema = z.object({
  theme: z.enum(["light", "dark"]),
  beats: z.boolean().optional(),
  // The bench payload is too dynamic for a tight Zod schema; we trust the
  // upstream API route to validate before passing inputProps.
  bench: z.any(),
});

export type BarChartRaceProps = {
  theme: "light" | "dark";
  bench: BenchPayload;
  /** Story beats: lead-change banners (opt-in from the export modal). */
  beats?: boolean;
};

/**
 * Aspect-aware layout. Landscape keeps the historical 1920x1080 numbers
 * bit-for-bit; portrait (Short 9:16) redistributes the vertical space so
 * the bar stack fills the middle band instead of leaving a dead gap
 * between the bars and the bottom-pinned date ticker.
 */
function layoutFor(width: number, height: number, barsN: number) {
  const isPortrait = height > width;
  if (!isPortrait) {
    return {
      isPortrait,
      pad: 80,
      titleTop: 64,
      titleSize: 64,
      metricSize: 22,
      topOffset: 320,
      // Eight rows at 78 px ended at 944 px, under the date ticker whose
      // top edge is at 904 px; rows now shrink to end by 880 px.
      rowH: Math.min(78, Math.floor((880 - 320) / Math.max(1, barsN))),
      labelW: 320,
      valueW: 200,
      nameSize: 28,
      valueSize: 32,
      chipSize: 48,
      barH: 44,
      rankSize: 20,
      dateSize: 96,
      dateBottom: 80,
      sourceBottom: 56,
    };
  }
  // Center the stack vertically in the band between the title block and
  // the bottom date/source zone, sized by the ACTUAL number of bars, so a
  // 3-provider export doesn't leave a dead band under the bars.
  const bandTop = 420;
  const bandBottom = height - 360;
  const band = bandBottom - bandTop;
  const rowH = Math.min(150, Math.floor(band / Math.max(1, barsN)));
  const topOffset = bandTop + Math.floor((band - rowH * barsN) / 2);
  return {
    isPortrait,
    pad: 56,
    titleTop: 64,
    titleSize: 46,
    metricSize: 20,
    topOffset,
    rowH,
    labelW: 290,
    valueW: 130,
    nameSize: 25,
    valueSize: 28,
    chipSize: 44,
    barH: 50,
    rankSize: 18,
    dateSize: 80,
    dateBottom: 150,
    sourceBottom: 84,
  };
}

export const BarChartRace: React.FC<BarChartRaceProps> = ({ theme, bench, beats }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  const t = themeFor(theme);
  const L = layoutFor(width, height, Math.min(VISIBLE_BARS, bench.providers.length));

  // Derive framesPerStep from the duration set by calculateMetadata, so
  // changing the speed prop upstream lengthens / shortens each step
  // uniformly without us having to thread the speed factor through here.
  // Floor by 4 frames so we never collapse below ~7fps step pace.
  const bodyFrames = Math.max(1, durationInFrames - HEAD_FRAMES - TAIL_FRAMES);
  const FRAMES_PER_STEP = Math.max(4, bodyFrames / Math.max(1, bench.timestamps.length));

  // Step index: which timestamp are we showing right now? Interpolates
  // smoothly between two adjacent timestamps so the bars don't snap.
  const stepFrame = Math.max(0, frame - HEAD_FRAMES);
  const stepIndexRaw = stepFrame / FRAMES_PER_STEP;
  const stepIndex = Math.min(stepIndexRaw, bench.timestamps.length - 1);
  const lowerIdx = Math.floor(stepIndex);
  const upperIdx = Math.min(lowerIdx + 1, bench.timestamps.length - 1);
  const stepFrac = stepIndex - lowerIdx;

  // Interpolate each provider's value between the two adjacent steps.
  // Using ease so bar widths feel like they're tracking, not blinking.
  const eased = easeInOutCubic(stepFrac);
  const liveProviders = bench.providers.map((p) => ({
    ...p,
    value: lerp(p.values[lowerIdx], p.values[upperIdx], eased),
  }));

  // Sort + rank. Top providers go to the top of the visible list. Crucially
  // we ALSO compute the rank one step earlier so the BarStack can tween a
  // bar's Y position when it swaps ranks — without this the bars snap from
  // one row to the next, which is the classic "broken bar chart race" look.
  const sorted = [...liveProviders].sort((a, b) =>
    bench.higherIsBetter ? b.value - a.value : a.value - b.value,
  );
  const visible = sorted.slice(0, VISIBLE_BARS);
  const maxValue = Math.max(...visible.map((p) => p.value));

  // Previous-step ranks for FLIP-style swap animation. At the timeline tail
  // (`lowerIdx === upperIdx === N-1`) there's no remaining transition to
  // animate AND `swapEase` collapses to 0 — without this guard the bars
  // would be positioned at the second-to-last step's order while their
  // values display the final step's values. That looked like the race
  // "loops between the last two days" with no clean stop. Snap `prevIdx`
  // to `lowerIdx` so `prevSorted == current sorted` and the rank tween is
  // a no-op pinning bars at their final ranks.
  const prevIdx =
    upperIdx === lowerIdx ? lowerIdx : Math.max(0, lowerIdx - 1);
  const prevSorted = [...bench.providers]
    .map((p) => ({ ...p, value: p.values[prevIdx] }))
    .sort((a, b) => (bench.higherIsBetter ? b.value - a.value : a.value - b.value))
    .slice(0, VISIBLE_BARS);
  const prevRankBySlug = new Map(prevSorted.map((p, i) => [p.slug, i]));

  // Title + scaffolding fade in over the first 15 frames.
  const introFade = remap(frame, 0, HEAD_FRAMES, 0, 1, easeOutCubic);

  // ── Delta badges (Polymarket-style) ────────────────────────────────
  // On each day transition, show the day-over-day change next to each
  // bar's value: fade in over ~8 frames at the start of the step,
  // persist, then fade out just before the next step begins. At the
  // timeline tail (no next step) the final day's delta persists.
  const frameInStep = stepFrame - lowerIdx * FRAMES_PER_STEP;
  const atTail = upperIdx === lowerIdx;
  const deltaFrom = atTail ? Math.max(0, lowerIdx - 1) : lowerIdx;
  const deltaTo = atTail ? lowerIdx : upperIdx;
  const deltaFadeIn = remap(
    frameInStep,
    0,
    Math.min(8, FRAMES_PER_STEP * 0.4),
    0,
    1,
    easeOutCubic,
  );
  const deltaFadeOut = atTail
    ? 1
    : remap(frameInStep, FRAMES_PER_STEP * 0.72, FRAMES_PER_STEP - 1, 1, 0);
  const deltaOpacity =
    deltaTo === deltaFrom ? 0 : Math.min(deltaFadeIn, deltaFadeOut) * introFade;
  const deltaBySlug = new Map(
    bench.providers.map((p) => [p.slug, p.values[deltaTo] - p.values[deltaFrom]]),
  );

  // Current date display. Linear between timestamps so the ticker reads
  // continuously like a clock.
  const displayedTs = lerp(
    bench.timestamps[lowerIdx],
    bench.timestamps[upperIdx],
    stepFrac,
  );
  const dateLabel = formatDate(displayedTs);

  const leadChanges = beats ? computeLeadChanges(bench) : [];

  return (
    <AbsoluteFill
      style={{
        background: t.background,
        fontFamily,
        transform: `scale(${kenBurnsScale(frame, durationInFrames)})`,
      }}
    >
      {/* Headline + metric */}
      <div
        style={{
          position: "absolute",
          top: L.titleTop,
          left: L.pad,
          right: L.pad,
          opacity: introFade,
        }}
      >
        <div
          style={{
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: t.inkFaint,
            marginBottom: 12,
          }}
        >
          OpenChainBench · Benchmark
        </div>
        <div
          style={{
            fontSize: L.titleSize,
            fontWeight: 800,
            letterSpacing: "-0.025em",
            color: t.ink,
            lineHeight: 1.05,
          }}
        >
          {bench.title}
        </div>
        <div
          style={{
            marginTop: 12,
            fontSize: L.metricSize,
            color: t.inkMuted,
            fontWeight: 500,
          }}
        >
          {bench.metric}
        </div>
      </div>

      {/* The bars themselves */}
      <BarStack
        bars={visible}
        maxValue={maxValue}
        unit={bench.unit}
        theme={t}
        opacity={introFade}
        prevRankBySlug={prevRankBySlug}
        swapEase={eased}
        layout={L}
        deltaBySlug={deltaBySlug}
        deltaOpacity={deltaOpacity}
        higherIsBetter={bench.higherIsBetter}
      />

      {/* 👑 Crown above the current #1 — tracks rank swaps via the same FLIP
          tween BarStack uses, so the crown glides between providers instead
          of teleporting on overtake. */}
      {visible[0] && (() => {
        const leader = visible[0];
        const prev = prevRankBySlug.get(leader.slug) ?? visible.length;
        const animatedRank = prev + (0 - prev) * eased;
        // Chip center inside the LABEL_W block: rank-num(32) + gap(14) + chip/2
        const chipCenterX = L.pad + 32 + 14 + L.chipSize / 2;
        const y = L.topOffset + animatedRank * L.rowH;
        return <LeaderCrown frame={frame} x={chipCenterX} y={y - 44} size={36} />;
      })()}

      {/* Big date ticker (the most-screenshotted element of every race
          video — keep it prominent) */}
      <div
        style={{
          position: "absolute",
          bottom: L.dateBottom,
          right: L.pad,
          fontSize: L.dateSize,
          fontWeight: 800,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.04em",
          color: t.ink,
          opacity: introFade,
          textAlign: "right",
        }}
      >
        {dateLabel}
      </div>

      {/* Source cite (persistent, bottom-left, low-key) */}
      <div
        style={{
          position: "absolute",
          bottom: L.sourceBottom,
          left: L.pad,
          fontSize: 16,
          color: t.inkMuted,
          opacity: introFade * 0.9,
          letterSpacing: "0.02em",
        }}
      >
        Source · openchainbench.com/benchmarks/{bench.slug}
      </div>

      {/* Wordmark (persistent, top-right corner, even lower-key) */}
      <div
        style={{
          position: "absolute",
          top: L.isPortrait ? 24 : 80,
          right: L.pad,
          fontSize: 18,
          fontWeight: 700,
          letterSpacing: "-0.01em",
          color: t.inkSoft,
          opacity: introFade * 0.6,
        }}
      >
        OpenChainBench
      </div>
      {leadChanges.map((b) => (
        <BeatBanner key={b.step} beat={b} stepFloat={stepIndex} isPortrait={L.isPortrait} />
      ))}
      <FilmOverlay />
    </AbsoluteFill>
  );
};

/**
 * Vertical stack of horizontal bars. Each bar's vertical position tweens
 * between its old rank and new rank as the race progresses; widths tween
 * with `value`. Both motions use the same eased step fraction so the swap
 * feels coherent.
 */
const BarStack: React.FC<{
  bars: (ProviderSeries & { value: number })[];
  maxValue: number;
  unit: string;
  theme: import("../lib/theme").Theme;
  opacity: number;
  /** Where each provider sat on the previous step (for swap tween). */
  prevRankBySlug: Map<string, number>;
  /** 0..1 progress through the current step, used to ease swaps. */
  swapEase: number;
  layout: ReturnType<typeof layoutFor>;
  /** Day-over-day delta per provider for the current step. */
  deltaBySlug: Map<string, number>;
  /** Shared fade for the delta badges (in → hold → out per step). */
  deltaOpacity: number;
  higherIsBetter: boolean;
}> = ({
  bars,
  maxValue,
  unit,
  theme: t,
  opacity,
  prevRankBySlug,
  swapEase,
  layout: L,
  deltaBySlug,
  deltaOpacity,
  higherIsBetter,
}) => {
  const ROW_H = L.rowH;
  const TOP_OFFSET = L.topOffset;
  const LEFT_PAD = L.pad;
  const RIGHT_PAD = L.pad;
  const LABEL_W = L.labelW;
  const VALUE_W = L.valueW;

  // Slight back-out overshoot for bars entering the visible top-8, so
  // they land with a touch of life instead of a dead stop. c1 kept low
  // (~0.9) for a subtle ~5-8px overshoot at typical row heights.
  const backOut = (x: number): number => {
    const c1 = 0.9;
    const c3 = c1 + 1;
    const u = Math.min(1, Math.max(0, x)) - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
  };

  return (
    <>
      {bars.map((bar, idx) => {
        const widthPct = Math.max(2, (bar.value / maxValue) * 100);
        // FLIP: interpolate Y position from previous rank to current rank
        // using the step's eased fraction so swaps glide rather than snap.
        // Providers that just entered the visible window animate from the
        // last visible slot (so they slide IN, not pop in) — with a fade
        // on first appearance and a slight overshoot on the landing.
        const isEntering = !prevRankBySlug.has(bar.slug);
        const prevRank = prevRankBySlug.get(bar.slug) ?? bars.length;
        const rankEase = isEntering ? backOut(swapEase) : swapEase;
        const animatedRank = prevRank + (idx - prevRank) * rankEase;
        const y = TOP_OFFSET + animatedRank * ROW_H;
        const enterFade = isEntering
          ? remap(swapEase, 0, 0.6, 0, 1, easeOutCubic)
          : 1;
        const delta = deltaBySlug.get(bar.slug) ?? 0;
        const improving = higherIsBetter ? delta > 0 : delta < 0;

        return (
          <div
            key={bar.slug}
            style={{
              position: "absolute",
              top: y,
              left: LEFT_PAD,
              right: RIGHT_PAD,
              height: Math.min(ROW_H - 12, 78),
              opacity: opacity * enterFade,
              transition: "none", // Remotion drives motion via frame, not CSS
              display: "flex",
              alignItems: "center",
              gap: 24,
            }}
          >
            {/* Provider name + tiny rank number + logo chip */}
            <div
              style={{
                width: LABEL_W,
                display: "flex",
                alignItems: "center",
                gap: 14,
              }}
            >
              <span
                style={{
                  width: 32,
                  fontSize: L.rankSize,
                  fontWeight: 700,
                  color: idx === 0 ? bar.color : t.inkFaint,
                  fontVariantNumeric: "tabular-nums",
                  textAlign: "right",
                }}
              >
                {String(idx + 1).padStart(2, "0")}
              </span>
              <ProviderChip name={bar.name} color={bar.color} logo={bar.logo} size={L.chipSize} theme={t} />
              <span
                style={{
                  fontSize: L.nameSize,
                  fontWeight: 700,
                  color: bar.color,
                  letterSpacing: "-0.01em",
                }}
              >
                {bar.name}
              </span>
            </div>

            {/* The bar track + filled bar. No overflow:hidden so the
                leader glow can bleed past the fill's edge. */}
            <div
              style={{
                flex: 1,
                height: L.barH,
                background: t.barTrack,
                borderRadius: 8,
                position: "relative",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: `${widthPct}%`,
                  background: bar.color,
                  borderRadius: 8,
                  // Subtle halo on the current leader's bar (~35% alpha).
                  boxShadow: idx === 0 ? `0 0 24px ${bar.color}59` : "none",
                }}
              />
            </div>

            {/* Animated value label + day-over-day delta badge */}
            <div
              style={{
                width: VALUE_W,
                position: "relative",
                textAlign: "right",
                fontSize: L.valueSize,
                fontWeight: 700,
                color: t.ink,
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "-0.01em",
              }}
            >
              <RollingNumber value={bar.value} unit={unit} fontSize={L.valueSize} />
              {delta !== 0 && (
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    top: -22,
                    fontSize: 17,
                    fontWeight: 600,
                    color: improving ? "#4ade80" : "#f87171",
                    opacity: deltaOpacity,
                    fontVariantNumeric: "tabular-nums",
                    letterSpacing: "-0.01em",
                    whiteSpace: "nowrap",
                  }}
                >
                  {delta > 0 ? "+" : "-"}
                  {formatValue(Math.abs(delta), unit)}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
};

function formatDate(ts: number): string {
  const d = new Date(ts);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${d.getUTCDate().toString().padStart(2, "0")} ${months[d.getUTCMonth()]}`;
}
