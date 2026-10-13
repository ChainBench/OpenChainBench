import { interpolate, useCurrentFrame } from "remotion";
import { ActHeader, ActShell, Flash, Footer, PAD, SphereWipe } from "../components/chrome";
import { Backdrop, Mark } from "../components/ui";
import type { Act } from "../data-types";
import { outCubic, phase } from "../motion";
import { C, F } from "../theme";

/**
 * Head lag, played on a clock.
 *
 * This bench asks who reports a new block first, so the picture is a single
 * shared time axis and six arrivals on it, not six lanes. The film's own
 * timing carries the measurement: a provider's marker lands at the moment its
 * measured lag says it should, scaled so one real second is SECONDS_TO_FRAMES
 * frames. You watch Mobula land, then Serialized a beat later, then a long
 * wait for the rest, which is exactly what the numbers say.
 */

const AXIS_MAX = 1.1; // seconds shown; anything slower gets the off-scale treatment
const SECONDS_TO_FRAMES = 42;
const START = 30; // the frame the block lands on

export function LagAct({ act }: { act: Act }) {
  const frame = useCurrentFrame();
  // Leaves room on the right for the name and value that sit beside the
  // marker: at full width the slowest providers pushed their own labels off
  // the frame.
  const trackW = 1920 - PAD * 2 - 520;

  const x = (seconds: number) => (Math.min(seconds, AXIS_MAX) / AXIS_MAX) * trackW;
  const ticks = [0, 0.25, 0.5, 0.75, 1.0];

  // The block landing: one ring, once, at the origin of the axis.
  const pulse = phase(frame, START, START + 26, outCubic);

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

        <div style={{ position: "relative", height: 500 }}>
          {/* The clock */}
          {ticks.map((t) => (
            <div key={t} style={{ position: "absolute", left: x(t), top: 0, height: 470 }}>
              <div style={{ width: 1, height: "100%", background: C.rule, opacity: 0.7 }} />
              <div
                style={{
                  position: "absolute",
                  top: 478,
                  left: -22,
                  width: 60,
                  textAlign: "center",
                  fontFamily: F.mono,
                  fontSize: 19,
                  color: C.inkFaint,
                }}
              >
                {t.toFixed(2)}s
              </div>
            </div>
          ))}

          {/* The block lands here */}
          <div style={{ position: "absolute", left: 0, top: 0, height: 470 }}>
            <div
              style={{
                position: "absolute",
                left: -1,
                width: 3,
                height: "100%",
                background: C.accent,
                opacity: 0.9,
              }}
            />
            {pulse > 0 && pulse < 1 && (
              <div
                style={{
                  position: "absolute",
                  left: -110,
                  top: 125,
                  width: 220,
                  height: 220,
                  borderRadius: "50%",
                  border: `3px solid ${C.accent}`,
                  opacity: (1 - pulse) * 0.8,
                  transform: `scale(${interpolate(pulse, [0, 1], [0.15, 1.5])})`,
                }}
              />
            )}
            <div
              style={{
                position: "absolute",
                left: -16,
                top: -42,
                fontFamily: F.mono,
                fontSize: 19,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: C.accent,
                whiteSpace: "nowrap",
                opacity: phase(frame, START - 6, START + 6),
              }}
            >
              block lands
            </div>
          </div>

          {act.field.map((p, i) => {
            const offScale = p.raw > AXIS_MAX;
            // Arrival time in frames IS the measurement, scaled.
            const arriveAt = START + Math.min(p.raw, AXIS_MAX + 0.12) * SECONDS_TO_FRAMES;
            const travel = phase(frame, START, arriveAt, outCubic);
            const landed = phase(frame, arriveAt, arriveAt + 8);
            // An off-scale runner parks at the end of the axis; its label then
            // reads to the LEFT so it stays inside the frame.
            const px = x(p.raw) * travel;
            const y = 18 + i * 74;
            const isWinner = i === 0;

            return (
              <div key={p.slug}>
                {/* The lane is only a guide, so it is barely there. */}
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: y + 26,
                    width: trackW,
                    height: 1,
                    background: C.rule,
                    opacity: 0.35,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: px - 26,
                    top: y,
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    opacity: travel > 0 ? 1 : 0,
                  }}
                >
                  <Mark logo={p.logo} size={52} />
                  <div
                    style={{
                      fontFamily: F.display,
                      fontWeight: 700,
                      fontSize: 27,
                      color: landed > 0.4 ? (isWinner ? C.accent : C.inkSoft) : C.inkFaint,
                      whiteSpace: "nowrap",
                      opacity: landed,
                    }}
                  >
                    {p.name}
                    <span
                      style={{
                        fontFamily: F.mono,
                        fontSize: 22,
                        color: isWinner ? C.accent : C.inkFaint,
                        marginLeft: 12,
                      }}
                    >
                      {p.value}
                      {p.unit}
                    </span>
                  </div>
                  {offScale && (
                    <div
                      style={{
                        fontFamily: F.mono,
                        fontSize: 17,
                        color: C.bad,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        opacity: landed,
                        whiteSpace: "nowrap",
                      }}
                    >
                      ← off this scale
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </ActShell>

      <Footer right={`${act.ranked} ranked · /benchmarks/${act.slug}`} />
      <SphereWipe at={0} dir={1} />
      <Flash at={14} />
      <Flash at={START} len={5} />
    </Backdrop>
  );
}
