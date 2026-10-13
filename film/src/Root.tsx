import { Composition } from "remotion";
import { Film, TOTAL_FRAMES } from "./Film";
import { FPS, H, W } from "./theme";

export function RemotionRoot() {
  return (
    <Composition
      id="OCBFilm"
      component={Film}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={W}
      height={H}
    />
  );
}
