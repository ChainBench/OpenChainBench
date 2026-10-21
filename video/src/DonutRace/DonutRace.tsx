import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont, fontFamily } from "@remotion/google-fonts/InterTight";
import { z } from "zod";
import type { BenchPayload } from "../BarChartRace/mock-data";
import { BenchFrame, stepFloat } from "../lib/bench-frame";
import { stableRanks, swapRank, readingsFor, crossingFades } from "../lib/rank";
import { themeFor } from "../lib/theme";
import { FilmOverlay, kenBurnsScale } from "../lib/cinematic";
import { easeOutCubic, easeInOutCubic, remap } from "../lib/easing";
import { ProviderChip } from "../lib/provider-chip";
import { CrownIcon, LeaderCrown } from "../lib/leader-crown";
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

  const last = bench.timestamps.length - 1;
  const lo = Math.min(intIdx, last), hi = Math.min(lo + 1, last), frac = idx - lo;
  const fps = Math.max(2, (durationInFrames - 75) / Math.max(1, bench.timestamps.length));
  // Each provider's "share" at the current step, interpolated between
  // readings (v26 read the integer step, so every slice jumped six times
  // a second). For lower-is-better metrics we invert (smaller value =
  // bigger share) so the donut reads "leader has the largest slice".
  const shareOf = (v: number) => (bench.higherIsBetter ? v : 1000 / Math.max(1, v));
  const slices = bench.providers.map((p) => {
    const raw = p.values[lo] + (p.values[hi] - p.values[lo]) * frac;
    return { slug: p.slug, name: p.name, color: p.color, logo: p.logo, share: shareOf(raw), raw };
  });
  const total = slices.reduce((s, x) => s + x.share, 0);
  // Ranks change only on an overtake that holds, each change one glide.
  const ranks = stableRanks(
    bench.providers.map((p) => p.values.map(shareOf)),
    true,
    readingsFor(0.4, fps),
    0.01,
  );
  const legendPos = new Map(bench.providers.map((p, j) => [p.slug, swapRank(ranks, j, idx, fps)]));
  const rankNow = (slug: string) => legendPos.get(slug)!;
  const fades = crossingFades(ranks, idx, bench.providers.map((p) => legendPos.get(p.slug)!), fps);
  const fadeOf = new Map(bench.providers.map((p, j) => [p.slug, fades[j]]));
  const sorted = [...slices].sort((a, b) => rankNow(a.slug) - rankNow(b.slug));
  const legendRows = sorted.filter((s) => rankNow(s.slug) < 8);

  // Timeline scaled to the clip: the fan takes the first 18%, the centre
  // spotlight walks the top three over the last 45%. v26 used fixed frame
  // numbers, so a 10 s clip cut the spotlight short and a 30 s clip sat on
  // a still donut for 15 s.
  const D = durationInFrames;
  const FAN_START = Math.round(D * 0.04);
  const FAN_SPAN = Math.round(D * 0.18);
  const SPOTLIGHT_START = Math.round(D * 0.5);
  const SPOTLIGHT_PER = Math.max(30, Math.round((D * 0.45) / 3));
  const spotT = (frame - SPOTLIGHT_START) / SPOTLIGHT_PER;
  const spotlightIdx = frame < SPOTLIGHT_START ? 0 : Math.max(0, Math.min(2, Math.floor(spotT)));
  const spotlight = sorted[spotlightIdx] ?? sorted[0];
  // Fade in at the start of each turn and out before the next one, so the
  // centre never hard-cuts from one name to another.
  const inTurn = frame < SPOTLIGHT_START ? remap(frame, FAN_START + FAN_SPAN * 0.6, FAN_START + FAN_SPAN, 0, 1, easeOutCubic) : spotT - spotlightIdx;
  const spotlightFade = frame < SPOTLIGHT_START
    ? inTurn
    : Math.min(remap(inTurn, 0, 0.12, 0, 1, easeOutCubic), spotlightIdx === 2 ? 1 : remap(inTurn, 0.88, 1, 1, 0, easeInOutCubic));
  const spotlightLift = (1 - spotlightFade) * 10;

  // Slices keep one order for the whole clip (mean share), so a change of
  // leader grows and shrinks slices instead of reshuffling the ring.
  const meanShare = (j: number) => bench.providers[j].values.reduce((s, v) => s + shareOf(v), 0) / Math.max(1, bench.providers[j].values.length);
  const ringOrder = bench.providers.map((_, j) => j).sort((a, b) => meanShare(b) - meanShare(a));
  const n = Math.max(1, ringOrder.length);
  // A slow quarter turn over the clip keeps the ring alive.
  const spin = remap(frame, 0, D, -10, 14);
  let cursor = -Math.PI / 2;
  const arcs = ringOrder.map((j, i) => {
    const s = slices[j];
    const angle = (s.share / total) * Math.PI * 2;
    const a0 = cursor;
    const a1 = cursor + angle;
    cursor = a1;
    const at = FAN_START + (i * FAN_SPAN * 0.5) / n;
    const reveal = remap(frame, at, at + FAN_SPAN * 0.5, 0, 1, easeInOutCubic);
    // The leader's slice stands out of the ring, eased with its rank.
    const pop = Math.max(0, 1 - rankNow(s.slug));
    return { ...s, a0, a1, reveal, pop };
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
          transform={`rotate(${spin} ${CENTRE_X} ${CENTRE_Y})`}
        >
          {arcs.map((a) => {
            const a1eff = a.a0 + (a.a1 - a.a0) * a.reveal;
            if (a.reveal <= 0.001) return null;
            const mid = (a.a0 + a1eff) / 2;
            const off = 14 * easeInOutCubic(a.pop);
            return (
              <g key={a.slug} transform={`translate(${Math.cos(mid) * off} ${Math.sin(mid) * off})`}>
                {a.pop > 0.01 && (
                  <path
                    d={donutPath(CENTRE_X, CENTRE_Y, R_OUTER, R_INNER, a.a0, a1eff)}
                    fill={a.color}
                    opacity={0.55 * a.pop}
                    filter="url(#leader-glow)"
                  />
                )}
                <path
                  d={donutPath(CENTRE_X, CENTRE_Y, R_OUTER, R_INNER, a.a0, a1eff)}
                  fill={a.color}
                  stroke={t.background}
                  strokeWidth={4}
                  strokeLinejoin="round"
                />
              </g>
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
          transform: `translateY(${spotlightLift}px)`,
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
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {spotlightIdx === 0 ? <><CrownIcon size={18} />Leader</> : `Rank ${spotlightIdx + 1}`}
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
          height: 8 * 62,
          fontFamily,
        }}
      >
        {legendRows.map((s) => {
          const pos = legendPos.get(s.slug)!;
          const i = Math.round(pos);
          // The row going down steps back while two rows pass.
          const rise = swapRank(ranks, bench.providers.findIndex((p) => p.slug === s.slug), idx - 0.05, fps) - pos;
          const crossing = fadeOf.get(s.slug) ?? 1;
          // Per-row staggered fade-in instead of one block opacity
          const rowFade = remap(frame, FAN_START + i * 6, FAN_START + 30 + i * 6, 0, 1, easeOutCubic);
          // Highlight the row of the current spotlight provider; dim the
          // rest, eased in and out with the spotlight itself.
          const spotlightActive = frame >= SPOTLIGHT_START;
          const isSpotlit = spotlightActive && s.slug === spotlight?.slug;
          const dim = spotlightActive && !isSpotlit ? 1 - 0.5 * Math.min(1, (frame - SPOTLIGHT_START) / 15) : 1;
          return (
          <div
            key={s.slug}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: pos * 62,
              display: "flex",
              alignItems: "center",
              gap: 14,
              height: 62,
              borderBottom: `1px solid ${t.rule}`,
              opacity: rowFade * dim * Math.max(0, Math.min(1, (7.5 - pos) * 2)) * crossing,
              zIndex: rise > 1e-4 ? 20 : 10,
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
