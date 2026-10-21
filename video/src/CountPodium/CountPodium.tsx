import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig } from "remotion";
import { loadFont, fontFamily } from "@remotion/google-fonts/InterTight";
import { z } from "zod";
import type { BenchPayload } from "../BarChartRace/mock-data";
import { BenchFrame } from "../lib/bench-frame";
import { themeFor } from "../lib/theme";
import { FilmOverlay, kenBurnsScale } from "../lib/cinematic";
import { easeOutCubic, remap } from "../lib/easing";
import { ProviderChip } from "../lib/provider-chip";
import { LeaderCrown } from "../lib/leader-crown";
import { formatValue } from "../lib/formatters";
import { stableRanks, swapRank, readingsFor, crossingFades } from "../lib/rank";

loadFont("normal", { weights: ["500", "600", "700", "800"] });

/**
 * Count podium, v27. The three pedestals rise together, then the podium
 * plays the timeline reading by reading: whoever holds 1st, 2nd and 3rd
 * on that day stands on that step, and an overtake is a hop from one
 * pedestal to the other. Ranks 4 and down run in a list beside it whose
 * rows fit the provider count. The last reading holds with the crown.
 *
 * v26 revealed the final standings bronze, silver, gold one after the
 * other and never moved: viewers asked for the three at once and for the
 * podium to follow the days.
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

/** Pedestal order on screen, left to right: 2nd, 1st, 3rd. */
const SLOT_OF_RANK = [1, 0, 2];
const MEDAL = ["#facc15", "#cbd5e1", "#d97706"];
const PEDESTAL_LABEL = ["1ST", "2ND", "3RD"];

function podiumGeom(width: number, height: number, n: number) {
  const isPortrait = height > width;
  const withList = n > 3;
  if (isPortrait) {
    return {
      isPortrait,
      BASELINE_Y: withList ? 1060 : 1260,
      BAR_W: 220,
      BAR_GAP: 48,
      BAND_LEFT: 0,
      BAND_W: width,
      HEIGHTS: [380, 300, 230],
      LIST_TOP: 1200,
      LIST_LEFT: 80,
      LIST_W: width - 160,
      LIST_BOTTOM: height - 280,
    };
  }
  return {
    isPortrait,
    BASELINE_Y: 900,
    BAR_W: 230,
    BAR_GAP: 56,
    // Without a list the podium takes the whole width.
    BAND_LEFT: withList ? 80 : 0,
    BAND_W: withList ? 1160 : width,
    HEIGHTS: [360, 290, 220],
    LIST_TOP: 330,
    LIST_LEFT: 1280,
    LIST_W: 560,
    LIST_BOTTOM: 860,
  };
}

export const CountPodium: React.FC<CountPodiumProps> = ({ theme: mode, bench }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames: D, width, height } = useVideoConfig();
  const t = themeFor(mode);
  const n = bench.providers.length;
  const G = podiumGeom(width, height, n);
  const steps = bench.timestamps.length;
  const last = Math.max(0, steps - 1);

  // Timeline: pedestals rise together (4% to 16%), the days play until
  // 82%, the last reading holds to the end with the crown.
  const RISE = Math.round(D * 0.04);
  const RACE_START = Math.round(D * 0.16);
  const RACE_END = Math.round(D * 0.82);
  const idx = remap(frame, RACE_START, RACE_END, 0, last);
  const framesPerStep = Math.max(2, (RACE_END - RACE_START) / Math.max(1, last));

  const lo = Math.floor(idx), hi = Math.min(lo + 1, last), frac = idx - lo;
  const valueOf = (v: number[]) => {
    const a = v[lo], b = v[hi];
    if (Number.isFinite(a) && Number.isFinite(b)) return a + (b - a) * frac;
    return Number.isFinite(a) ? a : b;
  };
  const ranks = stableRanks(
    bench.providers.map((p) => p.values),
    bench.higherIsBetter,
    readingsFor(0.4, framesPerStep),
    0.01,
  );
  const rows = bench.providers.map((p, j) => ({
    ...p,
    value: valueOf(p.values),
    pos: swapRank(ranks, j, idx, framesPerStep, 18),
    // Positive while the row climbs.
    rise: swapRank(ranks, j, idx - 0.05, framesPerStep, 18) - swapRank(ranks, j, idx, framesPerStep, 18),
  }));
  const fades = crossingFades(ranks, idx, rows.map((r) => r.pos), framesPerStep, 18);
  const fadeOf = new Map(rows.map((r, j) => [r.slug, fades[j]]));

  const pedestals = Math.min(3, n);
  const totalW = pedestals * G.BAR_W + (pedestals - 1) * G.BAR_GAP;
  const startX = G.BAND_LEFT + (G.BAND_W - totalW) / 2;
  // With fewer than three providers the slots close up: two pedestals are
  // [2nd, 1st], one is just the 1st.
  const slotOf = (rank: number) => (pedestals === 3 ? SLOT_OF_RANK[rank] : pedestals === 2 ? [1, 0][rank] : 0);
  const slotX = (rank: number) => startX + slotOf(rank) * (G.BAR_W + G.BAR_GAP);
  // Continuous rank -> card x between two pedestals.
  const cardX = (pos: number) => {
    const r0 = Math.max(0, Math.min(pedestals - 1, Math.floor(pos)));
    const r1 = Math.max(0, Math.min(pedestals - 1, r0 + 1));
    const f = Math.max(0, Math.min(1, pos - r0));
    return slotX(r0) + (slotX(r1) - slotX(r0)) * f;
  };
  const heightOf = (rank: number) => G.HEIGHTS[rank];
  const cardTop = (pos: number) => {
    const r0 = Math.max(0, Math.min(pedestals - 1, Math.floor(pos)));
    const r1 = Math.max(0, Math.min(pedestals - 1, r0 + 1));
    const f = Math.max(0, Math.min(1, pos - r0));
    return G.BASELINE_Y - (heightOf(r0) + (heightOf(r1) - heightOf(r0)) * f);
  };

  // All pedestals at once, one spring.
  const grow = spring({ frame: frame - RISE, fps, config: { damping: 14, stiffness: 120, mass: 0.9 }, durationInFrames: 36 });
  const cardsIn = remap(frame, RISE + 16, RISE + 34, 0, 1, easeOutCubic);
  const holdAt = RACE_END;

  // List of ranks 4 and down: rows fit the band, as many as it holds.
  const listN = Math.max(0, n - pedestals);
  const listRoom = G.LIST_BOTTOM - G.LIST_TOP - 44;
  const rowH = listN ? Math.max(34, Math.min(60, Math.floor(listRoom / listN))) : 0;
  const listMax = rowH ? Math.floor(listRoom / rowH) : 0;
  const k = rowH / 56;

  const gold = rows.reduce((a, b) => (b.pos < a.pos ? b : a), rows[0]);

  return (
    <AbsoluteFill style={{ background: t.background, fontFamily, transform: `scale(${kenBurnsScale(frame, D)})` }}>
      <BenchFrame bench={bench} theme={t} stepFloat={idx} totalFrames={D} />

      {/* Pedestals: medal-tinted, the same three for the whole clip. */}
      {Array.from({ length: pedestals }, (_, rank) => {
        const h = heightOf(rank) * grow;
        const x = slotX(rank);
        return (
          <div key={rank}>
            <div
              style={{
                position: "absolute",
                top: G.BASELINE_Y - h,
                left: x,
                width: G.BAR_W,
                height: h,
                borderRadius: "10px 10px 0 0",
                background: `linear-gradient(180deg, ${MEDAL[rank]}40 0%, ${MEDAL[rank]}14 60%, ${t.surface} 100%)`,
                boxShadow: `inset 0 5px 0 ${MEDAL[rank]}, 0 0 ${rank === 0 ? 70 : 30}px ${MEDAL[rank]}${rank === 0 ? "30" : "18"}`,
              }}
            />
            <div
              style={{
                position: "absolute",
                top: G.BASELINE_Y - h + 22,
                left: x,
                width: G.BAR_W,
                textAlign: "center",
                fontSize: 44,
                fontWeight: 800,
                color: MEDAL[rank],
                letterSpacing: "0.04em",
                opacity: grow,
              }}
            >
              {PEDESTAL_LABEL[rank]}
            </div>
          </div>
        );
      })}

      {/* Occupants: a card per provider standing on its current step. */}
      {rows.map((r) => {
        if (r.pos >= pedestals) return null;
        // Between 3rd and the first list row the card flies to (or from)
        // the row and shrinks to its size, so a provider entering the
        // podium is seen travelling, not swapped by a cross-fade.
        const fly = listN > 0 ? Math.max(0, Math.min(1, r.pos - (pedestals - 1))) : 0;
        const flyE = easeOutCubic(fly);
        const leave = listN > 0 ? Math.max(0, Math.min(1, (1 - fly) / 0.2)) : Math.max(0, Math.min(1, pedestals - r.pos));
        // Between two pedestals the climbing card hops over, the other
        // one ducks under, so the two never meet in the air.
        const arc = Math.sin(Math.PI * Math.max(0, Math.min(1, r.pos - Math.floor(r.pos))));
        // Signed by the direction of travel, smoothly: a card that turns
        // back mid-hop used to flip from 90 px up to 50 px down in a frame.
        const dir = Math.tanh(r.rise / 0.01);
        const hop = r.pos < pedestals - 1 ? (dir >= 0 ? 90 : 50) * dir * arc : 0;
        const x0 = cardX(r.pos), top0 = cardTop(r.pos) - 150 - hop;
        // List row 0: chip at LIST_LEFT + 50, row centre LIST_TOP + 44 + rowH / 2.
        const x1 = G.LIST_LEFT + 50 - G.BAR_W / 2 + 18, top1 = G.LIST_TOP + 44 + rowH / 2 - 30;
        const x = x0 + (x1 - x0) * flyE;
        const top = top0 + (top1 - top0) * flyE + (listN > 0 ? 0 : (1 - leave) * 40);
        const cardScale = 1 - 0.45 * flyE;
        const dim = fadeOf.get(r.slug) ?? 1;
        return (
          <div
            key={r.slug}
            style={{
              position: "absolute",
              top,
              left: x,
              width: G.BAR_W,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              opacity: cardsIn * leave * dim,
              transform: `scale(${cardScale})`,
              transformOrigin: "50% 30px",
              zIndex: r.rise > 1e-4 ? 200 : Math.round(100 - r.pos * 10),
            }}
          >
            <ProviderChip name={r.name} color={r.color} logo={r.logo} size={60} theme={t} />
            <div style={{ fontSize: 26, fontWeight: 700, color: r.color, letterSpacing: "-0.01em", whiteSpace: "nowrap", opacity: Math.max(0, 1 - fly * 2.5) }}>
              {r.name}
            </div>
            <div
              data-lab-value={formatValue(r.value, bench.unit)}
              style={{ fontSize: 36, fontWeight: 800, color: t.ink, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em", lineHeight: 1, opacity: Math.max(0, 1 - fly * 2.5) }}
            >
              {formatValue(r.value, bench.unit)}
            </div>
          </div>
        );
      })}

      {gold && (
        <LeaderCrown frame={frame} x={cardX(gold.pos) + G.BAR_W / 2} y={cardTop(gold.pos) - 200} revealAt={RISE + 24} size={52} />
      )}

      {/* Ranks 4 and down. */}
      {listN > 0 && (
        <div style={{ position: "absolute", top: G.LIST_TOP, left: G.LIST_LEFT, width: G.LIST_W }}>
          <div
            style={{
              fontSize: 16,
              fontWeight: 700,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: t.inkFaint,
              height: 44,
              opacity: cardsIn,
            }}
          >
            Also tracked
          </div>
          {rows.map((r) => {
            const slot = r.pos - pedestals;
            if (slot < -1 || slot > listMax) return null;
            const crossing = fadeOf.get(r.slug) ?? 1;
            // Row 0 shows once the flying card has landed on it.
            const op = crossing * Math.max(0, Math.min(1, (slot + 0.2) / 0.2)) * Math.max(0, Math.min(1, (listMax - 0.5 - slot) * 2));
            return (
              <div
                key={r.slug}
                style={{
                  position: "absolute",
                  top: 44 + Math.max(0, slot) * rowH,
                  left: 0,
                  right: 0,
                  height: rowH,
                  display: "flex",
                  alignItems: "center",
                  gap: 14 * k,
                  borderBottom: `1px solid ${t.rule}`,
                  opacity: cardsIn * op,
                  zIndex: r.rise > 1e-4 ? 20 : 10,
                  background: t.background,
                }}
              >
                <span style={{ width: 36, fontSize: 18 * k, color: t.inkFaint, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                  {String(Math.round(r.pos) + 1).padStart(2, "0")}
                </span>
                <ProviderChip name={r.name} color={r.color} logo={r.logo} size={Math.round(36 * Math.max(0.75, k))} theme={t} />
                <span style={{ flex: 1, fontSize: Math.max(17, 22 * k), fontWeight: 700, color: r.color, whiteSpace: "nowrap", overflow: "hidden" }}>
                  {r.name}
                </span>
                <span
                  data-lab-value={formatValue(r.value, bench.unit)}
                  style={{ fontSize: Math.max(17, 22 * k), color: t.inkMuted, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}
                >
                  {formatValue(r.value, bench.unit)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* A short flash on the winner when the days stop. */}
      {gold && frame >= holdAt && (
        <div
          style={{
            position: "absolute",
            left: cardX(gold.pos) - 40,
            top: cardTop(gold.pos) - 170,
            width: G.BAR_W + 80,
            height: 190,
            borderRadius: 24,
            background: `radial-gradient(closest-side, ${MEDAL[0]}33, transparent)`,
            opacity: remap(frame, holdAt, holdAt + 10, 0, 1, easeOutCubic) * remap(frame, holdAt + 10, holdAt + 40, 1, 0.35),
            pointerEvents: "none",
          }}
        />
      )}
      <FilmOverlay />
    </AbsoluteFill>
  );
};
