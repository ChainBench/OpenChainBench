import { fontFamily } from "@remotion/google-fonts/InterTight";
import type { BenchPayload } from "../types/bench";
import { easeOutCubic, remap } from "./easing";

/**
 * Story beats: pre-analysis of the series to find the narrative moments.
 * v1 detects lead changes (the #1 spot switching hands between two
 * consecutive steps). Capped at 3 banners per video so the device stays
 * scarce and each overtake lands.
 */
export type LeadChange = { step: number; name: string; color: string };

export function computeLeadChanges(bench: BenchPayload): LeadChange[] {
  const out: LeadChange[] = [];
  let prevLeader: string | null = null;
  for (let i = 0; i < bench.timestamps.length; i++) {
    let best = bench.providers[0];
    for (const p of bench.providers) {
      const better = bench.higherIsBetter
        ? p.values[i] > best.values[i]
        : p.values[i] < best.values[i];
      if (better) best = p;
    }
    if (prevLeader !== null && best.slug !== prevLeader) {
      out.push({ step: i, name: best.name, color: best.color });
    }
    prevLeader = best.slug;
  }
  if (out.length > 3) {
    const stride = out.length / 3;
    return [0, 1, 2].map((k) => out[Math.floor(k * stride)]);
  }
  return out;
}

/**
 * Centered pill that flashes when the lead changes hands. Driven by the
 * view's continuous step index: visible from the beat step for ~1.8
 * steps, fade in 0.25 step, fade out over the last 0.4.
 */
export const BeatBanner: React.FC<{
  beat: LeadChange;
  stepFloat: number;
  isPortrait: boolean;
}> = ({ beat, stepFloat, isPortrait }) => {
  const t = stepFloat - beat.step;
  if (t < 0 || t > 1.8) return null;
  const fadeIn = remap(t, 0, 0.25, 0, 1, easeOutCubic);
  const fadeOut = 1 - remap(t, 1.4, 1.8, 0, 1, easeOutCubic);
  const opacity = Math.min(fadeIn, fadeOut);
  const lift = (1 - fadeIn) * 14;
  return (
    <div
      style={{
        position: "absolute",
        top: isPortrait ? 330 : 208,
        left: "50%",
        transform: `translateX(-50%) translateY(${lift}px)`,
        background: beat.color,
        color: "#000000",
        padding: "10px 22px",
        borderRadius: 999,
        fontSize: isPortrait ? 19 : 21,
        fontWeight: 800,
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
        opacity,
        fontFamily,
        boxShadow: `0 0 28px ${beat.color}55`,
      }}
    >
      👑 {beat.name} takes the lead
    </div>
  );
};
