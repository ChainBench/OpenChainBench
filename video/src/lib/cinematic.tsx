import { staticFile, useCurrentFrame } from "remotion";

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
  // Grain "boil": re-seat the tile every 2 frames (~15 Hz). Every-frame
  // jumps read as flicker at 30 fps; static grain reads as a dirty lens.
  // 97/53 are coprime with the 256px tile so the walk never cycles short.
  const step = Math.floor(frame / 2);
  const gx = -((step * 97) % 256);
  const gy = -((step * 53) % 256);
  return (
    <>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.06,
          pointerEvents: "none",
          backgroundImage: `url(${staticFile("noise.png")})`,
          backgroundRepeat: "repeat",
          backgroundPosition: `${gx}px ${gy}px`,
        }}
      />
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
