import { useCurrentFrame, useVideoConfig } from "remotion";
import { ActHeader, ActShell, Flash, Footer, PAD, SphereWipe } from "../components/chrome";
import { Backdrop, Mark } from "../components/ui";
import type { Act } from "../data-types";
import { phase, slam } from "../motion";
import { C, F } from "../theme";

/**
 * Block time, played back as rhythm.
 *
 * Nothing here is a chart. Each chain emits a tick every time it would produce
 * a block, in real time, for four seconds: Robinhood Chain at 91 ms fires more
 * than forty, Blast at two seconds fires two. The difference is not described,
 * it is heard with the eyes, and the counter at the end is just the tally of
 * what already happened on screen.
 *
 * Because it runs at 1:1 with the clock, this act cannot be sped up without
 * lying, which is why it is the longest of the four.
 */

const RUN_SECONDS = 4;
const START = 40;
const TICK_W = 9;
const TICK_GAP = 5;

export function TempoAct({ act }: { act: Act }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const trackW = 1920 - PAD * 2 - 430;
  const maxTicks = Math.floor(trackW / (TICK_W + TICK_GAP));

  const elapsedMs = Math.max(0, ((frame - START) / fps) * 1000);
  const runT = phase(frame, START, START + RUN_SECONDS * fps);

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

        <div style={{ position: "relative" }}>
          {act.field.map((chain, i) => {
            const enter = slam(frame, fps, 18 + i * 4);
            // p50 block time in ms. The tick count is literally how many
            // blocks that cadence produces in the seconds elapsed on screen.
            const periodMs = act.unit === "ms" ? chain.raw : chain.raw * 1000;
            const emitted = Math.min(maxTicks, Math.floor(elapsedMs / periodMs));
            const isWinner = i === 0;

            return (
              <div
                key={chain.slug}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 18,
                  height: 74,
                  opacity: Math.min(1, enter * 1.5),
                  transform: `translateX(${(1 - enter) * -60}px)`,
                }}
              >
                <Mark logo={chain.logo} size={46} />
                <div
                  style={{
                    width: 250,
                    fontFamily: F.display,
                    fontWeight: 700,
                    fontSize: 29,
                    color: isWinner ? C.ink : C.inkSoft,
                    whiteSpace: "nowrap",
                  }}
                >
                  {chain.name}
                </div>

                <div style={{ width: trackW, display: "flex", gap: TICK_GAP, alignItems: "center" }}>
                  {Array.from({ length: emitted }).map((_, t) => {
                    // The newest tick flares, then settles: that flare is the
                    // only thing that makes a fast chain feel fast.
                    const age = emitted - 1 - t;
                    const fresh = age < 3 ? 1 - age / 3 : 0;
                    return (
                      <div
                        key={t}
                        style={{
                          width: TICK_W,
                          height: 30 + fresh * 14,
                          borderRadius: 2,
                          background: isWinner ? C.accent : C.ruleStrong,
                          opacity: 0.45 + fresh * 0.55,
                        }}
                      />
                    );
                  })}
                </div>

                <div
                  style={{
                    width: 160,
                    textAlign: "right",
                    fontFamily: F.display,
                    fontWeight: 700,
                    fontSize: 32,
                    color: isWinner ? C.accent : C.inkSoft,
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap",
                  }}
                >
                  {chain.value}
                  <span style={{ fontSize: 18, color: C.inkFaint, marginLeft: 4 }}>{chain.unit}</span>
                </div>
              </div>
            );
          })}

          <div
            style={{
              marginTop: 10,
              fontFamily: F.mono,
              fontSize: 20,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: C.inkFaint,
              opacity: phase(frame, START, START + 14),
            }}
          >
            {runT < 1 ? `${(RUN_SECONDS * runT).toFixed(1)} s elapsed, one tick per block` : "4 s elapsed"}
          </div>
        </div>
      </ActShell>

      <Footer right={`${act.ranked} ranked · /benchmarks/${act.slug}`} />
      <SphereWipe at={0} dir={-1} />
      <Flash at={14} />
    </Backdrop>
  );
}
