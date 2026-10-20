import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
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
 * Donut composition. Slices fan out sequentially from 12 o'clock, biggest
 * first so the visual hierarchy matches the underlying data. The centre
 * label crossfades between top-3 providers in the back half of the timeline,
 * acting as a "spotlight" reveal.
 *
 * Best suited to higher-is-better benches (coverage, market share). Pass a
 * dataset like MOCK_BENCH_COUNT for the most natural read.
 */

export const DONUT_DURATION_FRAMES = 510;

export const DonutRaceSchema = z.object({
  theme: z.enum(["light", "dark"]),
  bench: z.any(),
});

export type DonutRaceProps = {
  theme: "light" | "dark";
  bench: BenchPayload;
};

// Portrait: donut centered in the upper-middle band, legend stacked
// below it instead of in a right-hand column.
function donutGeom(width: number, height: number) {
  const isPortrait = height > width;
  return isPortrait
    ? { CENTRE_X: width / 2, CENTRE_Y: 760, R_OUTER: 300, R_INNER: 192,
        LEGEND_TOP: 1180, LEGEND_LEFT: 80, LEGEND_W: width - 160 }
    : { CENTRE_X: 720, CENTRE_Y: 600, R_OUTER: 280, R_INNER: 180,
        LEGEND_TOP: 320, LEGEND_LEFT: 1180, LEGEND_W: 660 };
}

export const DonutRace: React.FC<DonutRaceProps> = ({ theme: mode, bench }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  const { CENTRE_X, CENTRE_Y, R_OUTER, R_INNER, LEGEND_TOP, LEGEND_LEFT, LEGEND_W } = donutGeom(width, height);
  const t = themeFor(mode);
  const idx = stepFloat(frame, bench.timestamps.length, durationInFrames);
  const intIdx = Math.min(Math.floor(idx), bench.timestamps.length - 1);

  // Each provider's "share" at the current step. For lower-is-better metrics
  // we invert (smaller value = bigger share) so the donut reads "leader has
  // the largest slice". We keep the raw measurement around too so the
  // spotlight + legend can show "47 chains · 28.4%" — % alone is abstract.
  const slices = bench.providers.map((p) => {
    const raw = p.values[intIdx];
    const share = bench.higherIsBetter ? raw : 1000 / Math.max(1, raw);
    return {
      slug: p.slug,
      name: p.name,
      color: p.color,
      logo: p.logo,
      share,
      raw,
    };
  });
  const total = slices.reduce((s, x) => s + x.share, 0);
  const sorted = [...slices].sort((a, b) => b.share - a.share);

  // Fan-out timeline: each slice has a 30-frame reveal staggered by 12 frames
  const FAN_START = 30;
  const FAN_STEP = 18;
  const FAN_REVEAL = 36;

  // Spotlight cycle in the last ~6s: top 3 providers each get ~50 frames in
  // the centre label.
  const SPOTLIGHT_START = 240;
  const SPOTLIGHT_PER = 50;
  const spotlightIdx = Math.max(
    0,
    Math.min(2, Math.floor((frame - SPOTLIGHT_START) / SPOTLIGHT_PER)),
  );
  const spotlight = sorted[spotlightIdx] ?? sorted[0];
  const spotlightFade = remap(
    frame - SPOTLIGHT_START - spotlightIdx * SPOTLIGHT_PER,
    0,
    8,
    0,
    1,
    easeOutCubic,
  );

  // Build slice paths
  let cursor = -Math.PI / 2;
  const arcs = sorted.map((s, i) => {
    const angle = (s.share / total) * Math.PI * 2;
    const a0 = cursor;
    const a1 = cursor + angle;
    cursor = a1;
    const reveal = remap(
      frame,
      FAN_START + i * FAN_STEP,
      FAN_START + i * FAN_STEP + FAN_REVEAL,
      0,
      1,
      easeOutCubic,
    );
    return { ...s, a0, a1, reveal, idx: i };
  });

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

      <svg
        width={width}
        height={height}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        shapeRendering="geometricPrecision"
      >
        <defs>
          <filter id="leader-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="14" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* Subtle entrance rotation of the whole donut: -8° → 0° over 30 frames */}
        <g
          transform={`rotate(${remap(frame, 0, 30, -8, 0, easeOutCubic)} ${CENTRE_X} ${CENTRE_Y})`}
        >
          {arcs.map((a) => {
            const a1eff = a.a0 + (a.a1 - a.a0) * a.reveal;
            if (a.reveal <= 0.001) return null;
            const isLeader = a.idx === 0;
            return (
              <path
                key={a.slug}
                d={donutPath(CENTRE_X, CENTRE_Y, R_OUTER, R_INNER, a.a0, a1eff)}
                fill={a.color}
                stroke={t.background}
                strokeWidth={4}
                strokeLinejoin="round"
                filter={isLeader ? "url(#leader-glow)" : undefined}
              />
            );
          })}
        </g>
      </svg>

      {/* Crown 👑 on top of the donut, marking the leader at every frame */}
      <LeaderCrown
        frame={frame}
        x={CENTRE_X}
        y={CENTRE_Y - R_OUTER - 56}
        revealAt={FAN_START}
        size={54}
      />

      {/* Centre label (spotlight cycle) */}
      <div
        style={{
          position: "absolute",
          top: CENTRE_Y - 80,
          left: CENTRE_X - 200,
          width: 400,
          textAlign: "center",
          opacity: spotlightFade,
          fontFamily,
        }}
      >
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: spotlightIdx === 0 ? "#facc15" : t.inkFaint,
            marginBottom: 8,
          }}
        >
          {spotlightIdx === 0 ? "👑 Leader" : `Rank ${spotlightIdx + 1}`}
        </div>
        <div
          style={{
            fontSize: 48,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            color: spotlight?.color,
            lineHeight: 1,
          }}
        >
          {spotlight?.name}
        </div>
        <div
          data-lab-value={spotlight ? formatValue(spotlight.raw, bench.unit) : ""}
          style={{
            marginTop: 12,
            fontSize: 34,
            color: t.ink,
            fontVariantNumeric: "tabular-nums",
            fontWeight: 800,
            letterSpacing: "-0.02em",
          }}
        >
          {spotlight ? formatValue(spotlight.raw, bench.unit) : ""}
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 18,
            color: t.inkMuted,
            fontVariantNumeric: "tabular-nums",
            fontWeight: 600,
            letterSpacing: "0.06em",
          }}
        >
          {spotlight ? `${((spotlight.share / total) * 100).toFixed(1)}% of total` : ""}
        </div>
      </div>

      {/* Legend column on the right */}
      <div
        style={{
          position: "absolute",
          top: LEGEND_TOP,
          left: LEGEND_LEFT,
          width: LEGEND_W,
          fontFamily,
        }}
      >
        {sorted.slice(0, 8).map((s, i) => {
          // Per-row staggered fade-in instead of one block opacity
          const rowFade = remap(frame, 30 + i * 8, 70 + i * 8, 0, 1, easeOutCubic);
          // Highlight the row of the current spotlight provider; dim the rest
          const spotlightActive = frame >= SPOTLIGHT_START;
          const isSpotlit = spotlightActive && i === spotlightIdx;
          const dim = spotlightActive && !isSpotlit ? 0.45 : 1;
          return (
          <div
            key={s.slug}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              height: 62,
              borderBottom: `1px solid ${t.rule}`,
              opacity: rowFade * dim,
              transform: `translateY(${(1 - rowFade) * 12}px)`,
            }}
          >
            <span
              style={{
                width: 32,
                fontSize: 18,
                color: t.inkFaint,
                fontVariantNumeric: "tabular-nums",
                fontWeight: 600,
              }}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
            <ProviderChip name={s.name} color={s.color} logo={s.logo} size={40} theme={t} />
            <span
              style={{
                flex: 1,
                fontSize: 26,
                fontWeight: 700,
                color: isSpotlit ? s.color : t.ink,
              }}
            >
              {s.name}
            </span>
            <span
              data-lab-value={formatValue(s.raw, bench.unit)}
              style={{
                fontSize: 22,
                color: t.ink,
                fontVariantNumeric: "tabular-nums",
                fontWeight: 700,
                marginRight: 14,
              }}
            >
              {formatValue(s.raw, bench.unit)}
            </span>
            <span
              style={{
                fontSize: 18,
                color: s.color,
                fontVariantNumeric: "tabular-nums",
                fontWeight: 700,
                width: 64,
                textAlign: "right",
              }}
            >
              {((s.share / total) * 100).toFixed(1)}%
            </span>
          </div>
          );
        })}
      </div>
      <FilmOverlay />
    </AbsoluteFill>
  );
};

function donutPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  a0: number,
  a1: number,
): string {
  const largeArc = a1 - a0 > Math.PI ? 1 : 0;
  const x0o = cx + rOuter * Math.cos(a0);
  const y0o = cy + rOuter * Math.sin(a0);
  const x1o = cx + rOuter * Math.cos(a1);
  const y1o = cy + rOuter * Math.sin(a1);
  const x0i = cx + rInner * Math.cos(a1);
  const y0i = cy + rInner * Math.sin(a1);
  const x1i = cx + rInner * Math.cos(a0);
  const y1i = cy + rInner * Math.sin(a0);
  return [
    `M ${x0o} ${y0o}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x1o} ${y1o}`,
    `L ${x0i} ${y0i}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${x1i} ${y1i}`,
    "Z",
  ].join(" ");
}
