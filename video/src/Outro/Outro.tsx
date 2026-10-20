import { AbsoluteFill, useCurrentFrame } from "remotion";
import { loadFont, fontFamily } from "@remotion/google-fonts/InterTight";
import { z } from "zod";
import type { BenchPayload } from "../BarChartRace/mock-data";
import { themeFor } from "../lib/theme";
import { easeOutCubic, easeInOutCubic, remap } from "../lib/easing";
import { ProviderChip } from "../lib/provider-chip";
import { formatValue } from "../lib/formatters";

loadFont("normal", { weights: ["500", "600", "700", "800"] });

/**
 * 2-second closing frame stitched after every race. Pulls the leader out
 * of the bench (last value, sorted by higherIsBetter) and prints the
 * final ranking on a clean black slate — the same way Visual Capitalist
 * / FT data videos always end on a frozen "source + URL" beat that
 * survives a screenshot.
 *
 * Frame budget @ 30 fps (60 frames total):
 *   0-12   wordmark fades in
 *  12-30   leader name + final value pop in (stagger)
 *  30-48   URL slides up
 *  48-60   hold
 */

export const OUTRO_DURATION_FRAMES = 60;

export const OutroSchema = z.object({
  theme: z.enum(["light", "dark"]),
  bench: z.any(),
});

export type OutroProps = {
  theme: "light" | "dark";
  bench: BenchPayload;
};

export const Outro: React.FC<OutroProps> = ({ theme: mode, bench }) => {
  const frame = useCurrentFrame();
  const t = themeFor(mode);

  const last = bench.providers
    .map((p) => ({ ...p, value: p.values[p.values.length - 1] }))
    .sort((a, b) => (bench.higherIsBetter ? b.value - a.value : a.value - b.value));
  const leader = last[0];

  const wordmarkOpacity = remap(frame, 0, 12, 0, 1, easeOutCubic);
  const leaderOpacity = remap(frame, 12, 30, 0, 1, easeOutCubic);
  const leaderLift = remap(frame, 12, 30, 14, 0, easeOutCubic);
  const urlOpacity = remap(frame, 30, 48, 0, 1, easeOutCubic);
  const urlLift = remap(frame, 30, 48, 12, 0, easeOutCubic);
  const wordmarkSpread = remap(frame, 0, 24, 0.1, 0.2, easeInOutCubic);

  return (
    <AbsoluteFill
      style={{
        background: t.background,
        fontFamily,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Wordmark eyebrow */}
      <div
        style={{
          opacity: wordmarkOpacity,
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: `${wordmarkSpread}em`,
          textTransform: "uppercase",
          color: t.inkFaint,
          marginBottom: 48,
        }}
      >
        OpenChainBench
      </div>

      {/* Leader callout */}
      <div
        style={{
          opacity: leaderOpacity,
          transform: `translateY(${leaderLift}px)`,
          display: "flex",
          alignItems: "center",
          gap: 20,
          marginBottom: 24,
        }}
      >
        <ProviderChip
          name={leader.name}
          color={leader.color}
          logo={leader.logo}
          size={96}
          theme={t}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: t.inkFaint,
            }}
          >
            Leader
          </span>
          <span
            style={{
              fontSize: 80,
              fontWeight: 800,
              letterSpacing: "-0.025em",
              color: leader.color,
              lineHeight: 1,
            }}
          >
            {leader.name}
          </span>
        </div>
      </div>

      {/* Big metric value */}
      <div
        data-lab-value={formatValue(leader.value, bench.unit)}
        style={{
          opacity: leaderOpacity,
          transform: `translateY(${leaderLift}px)`,
          fontSize: 54,
          fontWeight: 700,
          color: t.ink,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.02em",
          marginBottom: 12,
        }}
      >
        {formatValue(leader.value, bench.unit)} <span style={{ color: t.inkMuted, fontWeight: 500 }}>· {bench.metric}</span>
      </div>

      {/* URL */}
      <div
        style={{
          opacity: urlOpacity,
          transform: `translateY(${urlLift}px)`,
          marginTop: 40,
          fontSize: 26,
          fontWeight: 600,
          color: t.inkMuted,
          letterSpacing: "0.02em",
        }}
      >
        openchainbench.com<span style={{ color: t.inkSoft }}>/benchmarks/{bench.slug}</span>
      </div>
    </AbsoluteFill>
  );
};

