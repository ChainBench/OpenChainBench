import { getInputProps, staticFile, useCurrentFrame } from "remotion";

/**
 * Grain in production renders: off since v26. lab/weight.mjs measured the
 * 15 Hz boil at about 90% of every file (45 MB for 22 s against 3.7 MB
 * without, same crf 19), and on the #000 background it does not show even
 * with contrast boosted 6x on the encoded frame. "static" costs 10 MB.
 */
export const GRAIN_MODE: "boil" | "static" | "off" = "off";

/**
 * Subtle film treatment shared by the data views: a pre-generated noise
 * tile (public/noise.png, repeated) + a radial vignette. Tuned to be
 * felt, not seen: the grain breaks up the flat #000 areas (and masks
 * residual banding), the vignette pulls the eye to the center.
 *
 * The tile is a PNG on purpose: an SVG feTurbulence filter here cost
 * ~5x render time (re-evaluated every frame by Chrome); painting a
 * repeated bitmap is free.
 */
export const FilmOverlay: React.FC = () => {
  const frame = useCurrentFrame();
  // Lab-only knob (lab/weight.mjs): "boil" (production), "static", "off".
  const grain = (getInputProps() as { labGrain?: string }).labGrain ?? GRAIN_MODE;
  // Grain "boil": re-seat the tile every 2 frames (~15 Hz). Every-frame
  // jumps read as flicker at 30 fps; static grain reads as a dirty lens.
  // 97/53 are coprime with the 256px tile so the walk never cycles short.
  const step = grain === "static" ? 0 : Math.floor(frame / 2);
  const gx = -((step * 97) % 256);
  const gy = -((step * 53) % 256);
  return (
    <>
      {grain !== "off" && <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.06,
          pointerEvents: "none",
          backgroundImage: `url(${staticFile("noise.png")})`,
          backgroundRepeat: "repeat",
          backgroundPosition: `${gx}px ${gy}px`,
        }}
      />}
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background:
            "radial-gradient(ellipse at center, rgba(0,0,0,0) 58%, rgba(0,0,0,0.32) 100%)",
        }}
      />
    </>
  );
};

/**
 * Micro Ken Burns: continuous 100% -> 102.5% zoom across the segment.
 * Slow enough to be subliminal; scale-up never reveals canvas edges.
 */
export function kenBurnsScale(frame: number, durationInFrames: number): number {
  const t = Math.min(1, Math.max(0, frame / Math.max(1, durationInFrames)));
  return 1 + 0.025 * t;
}
