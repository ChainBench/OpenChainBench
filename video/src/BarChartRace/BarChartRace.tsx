import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont, fontFamily } from "@remotion/google-fonts/InterTight";
import { z } from "zod";
import type { BenchPayload, ProviderSeries } from "./mock-data";
import { easeOutCubic, remap, lerp } from "../lib/easing";
import { ProviderChip } from "../lib/provider-chip";
import { themeFor } from "../lib/theme";
import { FilmOverlay, kenBurnsScale } from "../lib/cinematic";
import { computeLeadChanges, BeatBanner } from "../lib/beats";
import { LeaderCrown } from "../lib/leader-crown";
import { RollingNumber } from "../lib/rolling-number";
import { stableRanks, swapRank, readingsFor, crossingFades } from "../lib/rank";
import { formatValue } from "../lib/formatters";

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
 *   - rank is continuous and smoothed over ~0.6 s, so swaps glide
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
function layoutFor(width: number, height: number, barsN: number, names: string[], values: string[]) {
  const isPortrait = height > width;
  if (!isPortrait) {
    // The stack fills the band between the title block and the date
    // ticker (top edge 904 px) whatever the provider count: rows grow up
    // to 120 px and the stack is centred, so three providers no longer
    // sit in the top third with 330 px of black under them.
    const bandTop = 320, bandBottom = 880;
    const rowH = Math.min(120, Math.floor((bandBottom - bandTop) / Math.max(1, barsN)));
    const k = Math.min(1.35, Math.max(0.8, rowH / 78));
    const chipSize = Math.round(48 * k);
    const valueSize = Math.round(32 * k);
    // Label and value columns sized from what they hold: a fixed 320 px
    // let "Solana Foundation" run under the bar. Inter Tight 700 averages
    // ~0.56 em per character, tabular digits ~0.6 em.
    let nameSize = Math.round(28 * k);
    const longest = Math.max(4, ...names.map((n) => n.length));
    const fixed = 32 + 14 + chipSize + 14;
    nameSize = Math.max(18, Math.min(nameSize, Math.floor((520 - fixed) / (longest * 0.56))));
    const labelW = fixed + Math.ceil(longest * nameSize * 0.56);
    const widest = Math.max(4, ...values.map((v) => v.length));
    const valueW = Math.max(120, Math.ceil(widest * valueSize * 0.6) + 12);
    return {
      isPortrait,
      pad: 80,
      titleTop: 64,
      titleSize: 64,
      metricSize: 22,
      topOffset: bandTop + Math.floor((bandBottom - bandTop - rowH * barsN) / 2),
      rowH,
      labelW,
      valueW,
      nameSize,
      valueSize,
      chipSize,
      barH: Math.round(Math.min(rowH * 0.6, 44 * k)),
      rankSize: Math.round(20 * k),
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
  const longest = Math.max(4, ...names.map((n) => n.length));
  const nameSize = Math.max(17, Math.min(25, Math.floor((360 - 32 - 14 - 44 - 14) / (longest * 0.56))));
  const widest = Math.max(4, ...values.map((v) => v.length));
  return {
    isPortrait,
    pad: 56,
    titleTop: 64,
    titleSize: 46,
    metricSize: 20,
    topOffset,
    rowH,
    labelW: 32 + 14 + 44 + 14 + Math.ceil(longest * nameSize * 0.56),
    valueW: Math.max(110, Math.ceil(widest * 28 * 0.6) + 10),
    nameSize,
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
  // Every value the odometer may show, to size the value column once.
  const shown = bench.providers.flatMap((p) => [Math.max(...p.values), Math.min(...p.values), p.values[p.values.length - 1]]);
  const L = layoutFor(
    width,
    height,
    Math.min(VISIBLE_BARS, bench.providers.length),
    bench.providers.map((p) => p.name),
    shown.map((v) => formatValue(v, bench.unit)),
  );

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

  // Values move linearly between readings. An ease per step stopped and
  // restarted every bar six times a second (61 readings in ~10 s).
  const liveProviders = bench.providers.map((p) => ({
    ...p,
    value: lerp(p.values[lowerIdx], p.values[upperIdx], stepFrac),
  }));

  // Row position is a continuous rank. The old FLIP interpolated from the
  // previous step's rank to the CURRENT sorted index, which flips mid-step
  // when two interpolated values cross: rows teleported up to 418 px in a
  // single frame (lab motion pass, rpc-cluster-12). Here each provider's
  // rank at every reading is fixed, the position interpolates between
  // readings, and a 0.6 s moving average turns rank flips into glides.
  // v27: ranks only change on an overtake that holds (stableRanks), and
  // each change is one eased 16-frame glide (swapRank). The v26 moving
  // average turned every near-tie into a long half-overlap with a fade,
  // which read as two rows tangled together.
  const ranks = stableRanks(
    bench.providers.map((p) => p.values),
    bench.higherIsBetter,
    readingsFor(0.4, FRAMES_PER_STEP),
    0.01,
  );
  const posBySlug = new Map(
    bench.providers.map((p, i) => [p.slug, swapRank(ranks, i, stepIndex, FRAMES_PER_STEP)]),
  );
  const fades = crossingFades(ranks, stepIndex, bench.providers.map((p) => posBySlug.get(p.slug)!), FRAMES_PER_STEP);
  const fadeBySlug = new Map(bench.providers.map((p, i) => [p.slug, fades[i]]));
  // Direction of travel, so the row climbing passes in front.
  const riseBySlug = new Map(
    bench.providers.map((p, i) => [p.slug, swapRank(ranks, i, stepIndex - 0.05, FRAMES_PER_STEP) - posBySlug.get(p.slug)!]),
  );
  const sorted = [...liveProviders].sort((a, b) => posBySlug.get(a.slug)! - posBySlug.get(b.slug)!);
  // A row is drawn while any part of it is inside the top 8; it fades as
  // it slides under the last slot.
  const visible = sorted.filter((p) => posBySlug.get(p.slug)! < VISIBLE_BARS);
  // Scale: a row sliding out weighs less as it leaves, so the axis does
  // not rescale in one frame when it disappears.
  const maxValue = Math.max(
    ...visible.map((p) => p.value * Math.min(1, VISIBLE_BARS - posBySlug.get(p.slug)!)),
    ...visible.slice(0, 1).map((p) => p.value),
  );

  // Title + scaffolding fade in over the first 15 frames.
  const introFade = remap(frame, 0, HEAD_FRAMES, 0, 1, easeOutCubic);

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
        posBySlug={posBySlug}
        riseBySlug={riseBySlug}
        fadeBySlug={fadeBySlug}
        layout={L}
        settled={stepIndexRaw >= bench.timestamps.length - 1}
      />

      {/* Crown above the leading row, riding the same continuous rank. */}
      {visible[0] && (() => {
        // Chip center inside the LABEL_W block: rank-num(32) + gap(14) + chip/2
        const chipCenterX = L.pad + 32 + 14 + L.chipSize / 2;
        const y = L.topOffset + posBySlug.get(visible[0].slug)! * L.rowH;
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
 * Vertical stack of horizontal bars at their continuous rank. When two
 * rows cross, the one moving down fades behind the one moving up, so the
 * two names and values never read on top of each other.
 */
const BarStack: React.FC<{
  bars: (ProviderSeries & { value: number })[];
  maxValue: number;
  unit: string;
  theme: import("../lib/theme").Theme;
  opacity: number;
  posBySlug: Map<string, number>;
  riseBySlug: Map<string, number>;
  fadeBySlug: Map<string, number>;
  layout: ReturnType<typeof layoutFor>;
  /** The race is over: values are final, odometers rest on their digits. */
  settled: boolean;
}> = ({ bars, maxValue, unit, theme: t, opacity, posBySlug, riseBySlug, fadeBySlug, layout: L, settled }) => {
  const ROW_H = L.rowH;
  const TOP_OFFSET = L.topOffset;
  const LEFT_PAD = L.pad;
  const RIGHT_PAD = L.pad;
  const LABEL_W = L.labelW;
  const VALUE_W = L.valueW;

  return (
    <>
      {bars.map((bar) => {
        const pos = posBySlug.get(bar.slug)!;
        const widthPct = Math.max(2, (bar.value / maxValue) * 100);
        // A row leaving the top 8 is gone a third of a row under the last
        // slot, before it reaches the date ticker (holding it on the last
        // slot drew it on top of the row that took the slot).
        const y = TOP_OFFSET + pos * ROW_H;
        const rank = Math.round(pos);
        const leaving = Math.max(0, Math.min(1, (VISIBLE_BARS - 0.65 - pos) / 0.35));
        // While two rows pass, the one going down steps back a little;
        // the one going up stays bright and on top.
        const rise = riseBySlug.get(bar.slug) ?? 0;
        let near = Infinity;
        for (const other of bars) {
          if (other.slug !== bar.slug) near = Math.min(near, Math.abs(pos - posBySlug.get(other.slug)!));
        }
        const crossing = fadeBySlug.get(bar.slug) ?? 1;
        const scale = rise > 1e-4 && near < 0.8 ? 1 + 0.03 * (1 - near / 0.8) : 1;

        return (
          <div
            key={bar.slug}
            style={{
              position: "absolute",
              top: y,
              left: LEFT_PAD,
              right: RIGHT_PAD,
              height: Math.min(ROW_H - 12, 108),
              opacity: opacity * leaving * crossing,
              zIndex: rise > 1e-4 ? 200 : 100 - rank,
              transform: `scale(${scale})`,
              transformOrigin: "left center",
              display: "flex",
              alignItems: "center",
              gap: 24,
            }}
          >
            {/* Provider name + tiny rank number + logo chip */}
            <div
              style={{
                width: LABEL_W,
                flexShrink: 0,
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
                  color: rank === 0 ? bar.color : t.inkFaint,
                  fontVariantNumeric: "tabular-nums",
                  textAlign: "right",
                }}
              >
                {String(rank + 1).padStart(2, "0")}
              </span>
              <ProviderChip name={bar.name} color={bar.color} logo={bar.logo} size={L.chipSize} theme={t} />
              <span
                style={{
                  fontSize: L.nameSize,
                  fontWeight: 700,
                  color: bar.color,
                  letterSpacing: "-0.01em",
                  whiteSpace: "nowrap",
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
                  boxShadow: rank === 0 ? `0 0 24px ${bar.color}59` : "none",
                }}
              />
            </div>

            {/* Animated value label. The per-reading delta badges are gone:
                at six readings a second they flashed ten times a second. */}
            <div
              style={{
                width: VALUE_W,
                flexShrink: 0,
                whiteSpace: "nowrap",
                position: "relative",
                textAlign: "right",
                fontSize: L.valueSize,
                fontWeight: 700,
                color: t.ink,
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "-0.01em",
              }}
            >
              <RollingNumber value={bar.value} unit={unit} fontSize={L.valueSize} settled={settled} />
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
