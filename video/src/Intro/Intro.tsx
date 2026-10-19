import { AbsoluteFill } from "remotion";
import { z } from "zod";
import { Logo3D } from "./Logo3D";
import { BrandText } from "./BrandText";

/**
 * 3-second brand intro. Frame budget at 30 fps:
 *
 *   0-9     entrance: sphere fades + scales in
 *   9-78    rotation: sphere does a full 360° on Y with subtle X tilt
 *  18-36    text in:  "OpenChainBench" fades up under the sphere
 *  78-88    text out: text fades back down
 *  78-90    sphere out: opacity decays so the cut into the bench race
 *                       feels like a transition, not a jump cut
 *
 * The composition is theme-aware (light / dark) so the same source renders
 * a matching intro for either bench card background. Pre-render once per
 * theme, ffmpeg-concat in front of each bench race.
 */

export const INTRO_DURATION_FRAMES = 90;

export const IntroSchema = z.object({
  // Kept as a literal "dark" rather than a toggle: per art-direction the
  // sphere's brilliance reads strongest on pure black, and the lockup is
  // invariant across every bench so there's no reason to fork variants.
  theme: z.literal("dark"),
});

export type IntroProps = z.infer<typeof IntroSchema>;

export const Intro: React.FC<IntroProps> = () => {
  return (
    <AbsoluteFill style={{ background: "#000000" }}>
      <Logo3D theme="dark" />
      <BrandText theme="dark" />
    </AbsoluteFill>
  );
};
