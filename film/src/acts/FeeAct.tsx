import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { ActHeader, ActShell, Flash, Footer, PAD, SphereWipe } from "../components/chrome";
import { Backdrop, CountUp, Mark } from "../components/ui";
import type { Act } from "../data-types";
import { outCubic, phase, slam } from "../motion";
import { C, F } from "../theme";

/**
 * Bridge fees, as subtraction.
 *
 * The honest problem with this bench is that the differences are tiny: every
 * bridge here takes less than a fifth of a percent, so a bar chart of the
 * percentages would make a rounding error look like a scandal, and a bar of
 * what ARRIVES would be six identical full bars.
 *
 * So the transfer is the picture. A fixed $10,000 crosses, and what each
 * bridge keeps is shown in dollars, which is the number a reader can actually
 * feel. The bars are deliberately almost full, because that is the truth:
 * the spread between best and worst here is about eighteen dollars.
 */

const SENT = 10_000;
const START = 36;
const CROSS_FRAMES = 40;

export function FeeAct({ act }: { act: Act }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const barW = 1920 - PAD * 2 - 620;
  const cross = phase(frame, START, START + CROSS_FRAMES, outCubic);
  const worst = Math.max(...act.field.map((f) => f.raw));

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

        <div>
          {act.field.map((b, i) => {
            const enter = slam(frame, fps, 16 + i * 4);
            const feeUsd = (b.raw / 100) * SENT;
            const isWinner = i === 0;
            // The fee's share of the widest fee in the field, so the red tip is
            // comparable row to row without pretending it is to scale with the
            // transfer, which it is not and could not be.
            const tipW = 26 + (b.raw / worst) * 150;
            const settled = phase(frame, START + CROSS_FRAMES - 6, START + CROSS_FRAMES + 10);

            return (
              <div
                key={b.slug}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 18,
                  height: 78,
                  opacity: Math.min(1, enter * 1.5),
                  transform: `translateX(${(1 - enter) * -50}px)`,
                }}
              >
                <Mark logo={b.logo} size={46} />
                <div
                  style={{
                    width: 230,
                    fontFamily: F.display,
                    fontWeight: 700,
                    fontSize: 28,
                    color: isWinner ? C.ink : C.inkSoft,
                    whiteSpace: "nowrap",
                  }}
                >
                  {b.name}
                </div>

                <div style={{ width: barW, position: "relative", height: 34 }}>
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: C.surface,
                      borderRadius: 3,
                    }}
                  />
                  {/* What arrives. */}
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: `${cross * 100}%`,
                      background: isWinner
                        ? `linear-gradient(90deg, ${C.accentSoft}, ${C.accent})`
                        : C.ruleStrong,
                      borderRadius: 3,
                    }}
                  />
                  {/* What the bridge keeps, at the far end, in red. */}
                  <div
                    style={{
                      position: "absolute",
                      right: 0,
                      top: 0,
                      bottom: 0,
                      width: tipW,
                      background: C.bad,
                      opacity: settled * 0.85,
                      borderRadius: "0 3px 3px 0",
                    }}
                  />
                </div>

                <div
                  style={{
                    width: 150,
                    textAlign: "right",
                    fontFamily: F.display,
                    fontWeight: 700,
                    fontSize: 32,
                    color: C.bad,
                    fontVariantNumeric: "tabular-nums",
                    opacity: settled,
                    whiteSpace: "nowrap",
                  }}
                >
                  <CountUp
                    to={feeUsd}
                    delay={START + CROSS_FRAMES - 6}
                    duration={18}
                    format={(v) => `-$${v.toFixed(2)}`}
                  />
                </div>
                <div
                  style={{
                    width: 150,
                    textAlign: "right",
                    fontFamily: F.mono,
                    fontSize: 20,
                    color: isWinner ? C.accent : C.inkFaint,
                    fontVariantNumeric: "tabular-nums",
                    opacity: settled,
                    whiteSpace: "nowrap",
                  }}
                >
                  {b.value}
                  {b.unit}
                </div>
              </div>
            );
          })}

          <div
            style={{
              marginTop: 14,
              fontFamily: F.mono,
              fontSize: 20,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: C.inkFaint,
              opacity: interpolate(frame, [START + CROSS_FRAMES, START + CROSS_FRAMES + 14], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
            }}
          >
            The fee is drawn larger than life. On $10,000 the whole field sits inside twenty dollars
          </div>
        </div>
      </ActShell>

      <Footer right={`${act.ranked} ranked · /benchmarks/${act.slug}`} />
      <SphereWipe at={0} dir={-1} />
      <Flash at={14} />
    </Backdrop>
  );
}
