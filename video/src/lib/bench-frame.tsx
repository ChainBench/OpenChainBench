import { useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont, fontFamily } from "@remotion/google-fonts/InterTight";
import type { BenchPayload } from "../BarChartRace/mock-data";
import { easeOutCubic, lerp, remap } from "./easing";
import type { Theme } from "./theme";

loadFont("normal", { weights: ["500", "600", "700", "800"] });

/**
 * The chrome around every bench composition — title, metric subtitle,
 * date ticker, source cite, wordmark. Lives in one place so every view
 * frames the data the same way; if we tweak the layout once, all five
 * compositions inherit it.
 *
 * Pass the active step index so the date tick interpolates smoothly
 * between the two adjacent timestamps the view is currently showing.
 */

const HEAD_FRAMES = 15;

export const BenchFrame: React.FC<{
  bench: BenchPayload;
  theme: Theme;
  stepFloat: number;
  totalFrames: number;
}> = ({ bench, theme: t, stepFloat, totalFrames }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  // Portrait (Short 9:16): tighter pads, narrower title block, date ticker
  // lifted above the bottom safe zone so the chrome hugs the content
  // instead of stretching across the full 1920px height.
  const isPortrait = height > width;
  const pad = isPortrait ? 56 : 80;

  const introFade = remap(frame, 0, HEAD_FRAMES, 0, 1, easeOutCubic);
  const outroFade = remap(frame, totalFrames - 12, totalFrames, 1, 0, easeOutCubic);
  const opacity = Math.min(introFade, outroFade);

  // Interpolate timestamp continuously so the ticker reads like a clock.
  const lowerIdx = Math.floor(stepFloat);
  const upperIdx = Math.min(lowerIdx + 1, bench.timestamps.length - 1);
  const displayedTs = lerp(
    bench.timestamps[lowerIdx],
    bench.timestamps[upperIdx],
    stepFloat - lowerIdx,
  );

  return (
    <>
      {/* Eyebrow + headline + metric (top-left block) */}
      <div
        style={{
          position: "absolute",
          top: 64,
          left: pad,
          right: isPortrait ? pad : 480,
          opacity,
          fontFamily,
        }}
      >
        <div
          style={{
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: t.inkFaint,
            marginBottom: 14,
          }}
        >
          OpenChainBench · Benchmark
        </div>
        <div
          style={{
            fontSize: isPortrait ? 44 : 56,
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
            marginTop: 14,
            fontSize: 22,
            color: t.inkMuted,
            fontWeight: 500,
          }}
        >
          {bench.metric}
        </div>
      </div>

      {/* Big date ticker (the most-screenshotted element of every race
          video — keep it prominent) */}
      <div
        style={{
          position: "absolute",
          bottom: isPortrait ? 150 : 92,
          right: pad,
          fontSize: isPortrait ? 80 : 96,
          fontWeight: 800,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.04em",
          color: t.ink,
          opacity,
          textAlign: "right",
          fontFamily,
        }}
      >
        {formatDate(displayedTs)}
      </div>

      {/* Source cite (persistent, bottom-left, low-key) */}
      <div
        style={{
          position: "absolute",
          bottom: isPortrait ? 84 : 56,
          left: pad,
          fontSize: 16,
          color: t.inkMuted,
          opacity: opacity * 0.9,
          letterSpacing: "0.02em",
          fontFamily,
        }}
      >
        Source · openchainbench.com/benchmarks/{bench.slug}
      </div>

      {/* Wordmark (persistent, top-right corner, even lower-key) */}
      <div
        style={{
          position: "absolute",
          top: isPortrait ? 24 : 80,
          right: pad,
          fontSize: 18,
          fontWeight: 700,
          letterSpacing: "-0.01em",
          color: t.inkSoft,
          opacity: opacity * 0.6,
          fontFamily,
        }}
      >
        OpenChainBench
      </div>
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

const TAIL_FRAMES = 60;

/**
 * Shared helper: continuous step index given the current frame.
 *
 * The step pace is derived from the composition's actual duration (not
 * a fixed 15 fpr step) so the race spans the full timeline regardless
 * of how long the user picked the video to be. Without this, TimeSeries
 * / Distribution / Donut / CountPodium reach their last step early and
 * freeze for the rest of the duration.
 *
 * Layout:
 *   [head ramp] [race body — N steps spread evenly] [tail hold]
 * `head` lets the chrome fade in; `tail` reserves the final ~2s for a
 * short hold + the BenchFrame outroFade.
 */
export function stepFloat(
  frame: number,
  totalSteps: number,
  durationInFrames: number,
): number {
  const safeSteps = Math.max(1, totalSteps);
  const body = Math.max(1, durationInFrames - HEAD_FRAMES - TAIL_FRAMES);
  const framesPerStep = Math.max(2, body / safeSteps);
  const stepFrame = Math.max(0, frame - HEAD_FRAMES);
  return Math.min(stepFrame / framesPerStep, safeSteps - 1);
}
