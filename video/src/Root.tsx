import { Composition } from "remotion";
import { Intro, INTRO_DURATION_FRAMES, IntroSchema } from "./Intro/Intro";
import {
  BarChartRace,
  BAR_RACE_DURATION_FRAMES,
  BarChartRaceSchema,
} from "./BarChartRace/BarChartRace";
import { MOCK_BENCH, MOCK_BENCH_COUNT } from "./BarChartRace/mock-data";
import { TimeSeriesRace, TIME_SERIES_DURATION_FRAMES, TimeSeriesRaceSchema } from "./TimeSeriesRace/TimeSeriesRace";
import { DonutRace, DONUT_DURATION_FRAMES, DonutRaceSchema } from "./DonutRace/DonutRace";
import { CountPodium, COUNT_PODIUM_DURATION_FRAMES, CountPodiumSchema } from "./CountPodium/CountPodium";
import { ResultsBoard, RESULTS_BOARD_DURATION_FRAMES, ResultsBoardSchema } from "./ResultsBoard/ResultsBoard";
import { Outro, OUTRO_DURATION_FRAMES, OutroSchema } from "./Outro/Outro";
import { withLabProbe } from "./lib/lab-probe";
import { withLegible } from "./lib/legible";

/**
 * Remotion composition registry. Each entry is a stand-alone video.
 *
 * - `Intro` is the brand intro that will be pre-rendered once per theme
 *   and ffmpeg-concat'd in front of every bench race.
 * - `BarChartRace` is the per-bench animated race. Driven by inputProps,
 *   so the same composition serves every benchmark; the API route just
 *   passes a different `bench` payload.
 */
export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="Intro"
        component={withLabProbe(Intro)}
        durationInFrames={INTRO_DURATION_FRAMES}
        fps={30}
        width={1920}
        height={1080}
        schema={IntroSchema}
        defaultProps={{
          theme: "dark" as const,
        }}
      />
      <Composition
        id="BarChartRace"
        component={withLabProbe(withLegible(BarChartRace))}
        durationInFrames={BAR_RACE_DURATION_FRAMES}
        fps={30}
        width={1920}
        height={1080}
        schema={BarChartRaceSchema}
        defaultProps={{
          theme: "dark" as const,
          bench: MOCK_BENCH,
        }}
      />
      <Composition
        id="TimeSeriesRace"
        component={withLabProbe(withLegible(TimeSeriesRace))}
        durationInFrames={TIME_SERIES_DURATION_FRAMES}
        fps={30}
        width={1920}
        height={1080}
        schema={TimeSeriesRaceSchema}
        defaultProps={{ theme: "dark" as const, bench: MOCK_BENCH }}
      />
      <Composition
        id="DonutRace"
        component={withLabProbe(withLegible(DonutRace))}
        durationInFrames={DONUT_DURATION_FRAMES}
        fps={30}
        width={1920}
        height={1080}
        schema={DonutRaceSchema}
        defaultProps={{ theme: "dark" as const, bench: MOCK_BENCH_COUNT }}
      />
      <Composition
        id="CountPodium"
        component={withLabProbe(withLegible(CountPodium))}
        durationInFrames={COUNT_PODIUM_DURATION_FRAMES}
        fps={30}
        width={1920}
        height={1080}
        schema={CountPodiumSchema}
        defaultProps={{ theme: "dark" as const, bench: MOCK_BENCH_COUNT }}
      />
      <Composition
        id="ResultsBoard"
        component={withLabProbe(withLegible(ResultsBoard))}
        durationInFrames={RESULTS_BOARD_DURATION_FRAMES}
        fps={30}
        width={1920}
        height={1080}
        schema={ResultsBoardSchema}
        defaultProps={{ theme: "dark" as const, bench: MOCK_BENCH }}
      />
      <Composition
        id="Outro"
        component={withLabProbe(withLegible(Outro))}
        durationInFrames={OUTRO_DURATION_FRAMES}
        fps={30}
        width={1920}
        height={1080}
        schema={OutroSchema}
        defaultProps={{ theme: "dark" as const, bench: MOCK_BENCH }}
      />
    </>
  );
};
