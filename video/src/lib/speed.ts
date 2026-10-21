/**
 * Race duration control.
 *
 * The user picks the total race length in seconds (5 → 60) via a slider.
 * BarChartRace honours this by scaling its per-step duration from the
 * resulting `durationInFrames` (read at runtime via `useVideoConfig()`),
 * so the visual pace stays uniform across data window sizes. The other
 * four views stretch/compress their fixed timeline to match.
 *
 * Single source of truth — every consumer (compositions, PreviewPlayer,
 * render route, UI) imports from here.
 */

const FPS = 30;

export const MIN_RACE_SECONDS = 5;
export const MAX_RACE_SECONDS = 60;
export const DEFAULT_RACE_SECONDS = 17;

export function clampRaceSeconds(s: number): number {
  if (!Number.isFinite(s)) return DEFAULT_RACE_SECONDS;
  return Math.max(MIN_RACE_SECONDS, Math.min(MAX_RACE_SECONDS, Math.round(s)));
}

/** Race body length in frames. The compositions read this back via useVideoConfig. */
export function raceDurationFromSeconds(seconds: number): number {
  return clampRaceSeconds(seconds) * FPS;
}
