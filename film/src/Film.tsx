import { AbsoluteFill, Sequence } from "remotion";
import { Close, ColdOpen, Crowd, RpcAct, UsesAct } from "./acts/Bookends";
import { FeeAct } from "./acts/FeeAct";
import { LagAct } from "./acts/LagAct";
import { TempoAct } from "./acts/TempoAct";
import { VolumeAct } from "./acts/VolumeAct";
import { useBrandFonts } from "./components/Fonts";
import { FILM } from "./data";
import type { Act } from "./data-types";
import { C } from "./theme";

/**
 * The cut.
 *
 * Four benchmarks, four different pictures. The previous version ran the same
 * bar chart four times and the film became a list: by the third table the eye
 * has learned the shape and stops reading. Each act here is drawn from what
 * its bench actually measures, so the form carries information rather than
 * repeating it:
 *
 *   lag     arrivals on one shared clock, in the order and spacing measured
 *   volume  accumulation into columns, because throughput is mass not speed
 *   fee     subtraction from a $10,000 transfer, in dollars a reader can feel
 *   tempo   the measurement played at 1:1, one tick per block, for four seconds
 *
 * The tempo act is the longest because it cannot be sped up without lying.
 */
const SHAPES: Record<Act["shape"], (p: { act: Act }) => React.ReactElement> = {
  lag: LagAct,
  volume: VolumeAct,
  fee: FeeAct,
  tempo: TempoAct,
};

const D = {
  coldOpen: 96,
  crowd: 126,
  lag: 168,
  volume: 150,
  fee: 156,
  tempo: 200,
  rpc: 150,
  uses: 126,
  close: 114,
} as const;

function actFrames(shape: Act["shape"]): number {
  return D[shape];
}

export function Film() {
  const fontsReady = useBrandFonts();
  if (!fontsReady) return <AbsoluteFill style={{ background: C.paper }} />;

  let at = 0;
  const cuts: Array<{ id: string; from: number; frames: number; node: React.ReactNode }> = [];
  const push = (id: string, frames: number, node: React.ReactNode) => {
    cuts.push({ id, from: at, frames, node });
    at += frames;
  };

  push("cold-open", D.coldOpen, <ColdOpen />);
  push("crowd", D.crowd, <Crowd />);
  for (const act of FILM.acts as readonly unknown[] as Act[]) {
    const Shape = SHAPES[act.shape];
    push(`act-${act.slug}`, actFrames(act.shape), <Shape act={act} />);
  }
  push("rpc", D.rpc, <RpcAct />);
  push("uses", D.uses, <UsesAct />);
  push("close", D.close, <Close />);

  return (
    <AbsoluteFill style={{ background: C.paper }}>
      {cuts.map((c) => (
        <Sequence key={c.id} from={c.from} durationInFrames={c.frames} name={c.id}>
          {c.node}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}

/** Derived from the cut above, so the composition length cannot drift from it. */
export const TOTAL_FRAMES =
  D.coldOpen +
  D.crowd +
  (FILM.acts as readonly { shape: Act["shape"] }[]).reduce((a, s) => a + actFrames(s.shape), 0) +
  D.rpc +
  D.uses +
  D.close;
