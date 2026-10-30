import { interpolate, spring } from "remotion";

/**
 * The film's movement vocabulary.
 *
 * The first cut faded everything up with one gentle spring, which read as a
 * slideshow. These are deliberately harder: things arrive past their mark and
 * settle back, which is what makes a cut feel struck rather than dissolved.
 */

/** Overshoots and snaps back. For anything that should land hard. */
export function slam(frame: number, fps: number, delay = 0) {
  return spring({
    frame: frame - delay,
    fps,
    config: { damping: 11, mass: 0.5, stiffness: 190 },
  });
}

/** Settles without overshoot. For anything that should not call attention. */
export function settle(frame: number, fps: number, delay = 0) {
  return spring({
    frame: frame - delay,
    fps,
    config: { damping: 200, mass: 0.6, stiffness: 120 },
  });
}

/** Fast out, slow in. The workhorse ease for travel. */
export const outQuint = (x: number) => 1 - Math.pow(1 - x, 5);
export const outCubic = (x: number) => 1 - Math.pow(1 - x, 3);
export const inOutCubic = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/** 0 to 1 across a window, clamped at both ends. */
export function phase(frame: number, from: number, to: number, easing = outCubic) {
  return interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });
}

/**
 * A deterministic shuffle, so the field starts in a scrambled order and the
 * race sorts it. Seeded by the act index: the same act always scrambles the
 * same way, which matters because two renders of one film must match.
 */
export function scramble(n: number, seed: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  let s = seed * 9301 + 49297;
  for (let i = n - 1; i > 0; i -= 1) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
