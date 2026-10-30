import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { ActHeader, ActShell, Flash, Footer, PAD, SphereWipe } from "../components/chrome";
import { Backdrop, CountUp, Mark } from "../components/ui";
import type { Act } from "../data-types";
import { outCubic, phase, slam } from "../motion";
import { C, F } from "../theme";

/**
 * Swaps routed, as accumulation.
 *
 * A throughput bench is not a speed bench, so it does not get a race. Volume
 * piles up: each terminal is a column, swaps fall into it, and the column
 * holds what it caught. The columns are vertical for the same reason the
 * latency act is horizontal, so that two different claims never arrive in the
 * same shape.
 */

const COL_W = 236;
const COL_GAP = 46;
const MAX_H = 400;
const START = 34;
const FILL_FRAMES = 62;

/** Deterministic jitter, so the rain is uneven but identical on every render. */
function jitter(seed: number): number {
  const x = Math.sin(seed * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

export function VolumeAct({ act }: { act: Act }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const best = Math.max(...act.field.map((f) => f.raw));
  const fill = phase(frame, START, START + FILL_FRAMES, outCubic);

  return (
    <Backdrop>
      <ActShell
        header={
          <ActHeader
          category={act.category}
          categoryLine={act.categoryLine}
          claim={act.claim}
          benchesInCategory={act.benchesInCategory}
          />
        }
      >

        <div
          style={{
            display: "flex",
            gap: COL_GAP,
            alignItems: "flex-end",
            height: MAX_H + 150,
          }}
        >
          {act.field.map((t, i) => {
            const enter = slam(frame, fps, 16 + i * 4);
            const target = (t.raw / best) * MAX_H;
            const h = target * fill;
            const isWinner = i === 0;

            return (
              <div
                key={t.slug}
                style={{
                  width: COL_W,
                  opacity: Math.min(1, enter * 1.5),
                  transform: `translateY(${(1 - enter) * 40}px)`,
                }}
              >
                {/* Falling swaps, only while the column is still filling. */}
                <div style={{ position: "relative", height: MAX_H }}>
                  {fill < 1 &&
                    Array.from({ length: 7 }).map((_, d) => {
                      const seed = i * 13 + d;
                      const cycle = (frame * (2.2 + jitter(seed) * 2) + jitter(seed + 5) * 90) % 90;
                      const dy = (cycle / 90) * (MAX_H - h);
                      return (
                        <div
                          key={d}
                          style={{
                            position: "absolute",
                            left: 14 + jitter(seed + 9) * (COL_W - 36),
                            top: dy,
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: isWinner ? C.accent : C.ruleStrong,
                            opacity: 0.5,
                          }}
                        />
                      );
                    })}

                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      bottom: 0,
                      width: "100%",
                      height: h,
                      background: isWinner
                        ? `linear-gradient(180deg, ${C.accent}, ${C.accentSoft})`
                        : `linear-gradient(180deg, ${C.ruleStrong}, ${C.surface})`,
                      borderRadius: "4px 4px 0 0",
                    }}
                  />
                  {/* The surface of the pile catches the light. */}
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      bottom: h,
                      width: "100%",
                      height: 3,
                      background: isWinner ? C.accent : C.inkFaint,
                      opacity: 0.9,
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      bottom: h + 12,
                      width: "100%",
                      textAlign: "center",
                      fontFamily: F.display,
                      fontWeight: 700,
                      fontSize: 34,
                      color: isWinner ? C.accent : C.inkSoft,
                      fontVariantNumeric: "tabular-nums",
                      opacity: interpolate(fill, [0.15, 0.5], [0, 1], {
                        extrapolateLeft: "clamp",
                        extrapolateRight: "clamp",
                      }),
                    }}
                  >
                    <CountUp
                      to={t.raw}
                      delay={START}
                      duration={FILL_FRAMES}
                      format={(v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : `${Math.round(v / 1e3)}k`)}
                    />
                  </div>
                </div>

                <div style={{ marginTop: 18, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                  <Mark logo={t.logo} size={54} />
                  <div
                    style={{
                      fontFamily: F.mono,
                      fontSize: 17,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: isWinner ? C.accent : C.inkFaint,
                      textAlign: "center",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.name}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </ActShell>

      <Footer right={`${act.ranked} ranked · /benchmarks/${act.slug}`} />
      <SphereWipe at={0} dir={1} />
      <Flash at={14} />
    </Backdrop>
  );
}
