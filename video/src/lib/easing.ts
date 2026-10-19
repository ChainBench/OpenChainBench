/**
 * Easing functions used across compositions. Remotion exposes a few via
 * `Easing.bezier(...)` but inline cubics give us tighter control + cleaner
 * call sites in the timeline-heavy bits.
 */

export const easeOutCubic = (t: number): number => {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
};

export const easeInOutCubic = (t: number): number => {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped < 0.5
    ? 4 * clamped * clamped * clamped
    : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
};

export const easeInCubic = (t: number): number => {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * clamped;
};

/** Sample a value linearly between [a, b] using a 0..1 progress. */
export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * Math.min(1, Math.max(0, t));

/**
 * Map an input range to an output range with optional easing. Mirrors
 * Remotion's `interpolate` but is reusable in places where we already
 * know the eased progress (e.g. inside a useFrame replacement).
 */
export const remap = (
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
  easing: (t: number) => number = (x) => x,
): number => {
  if (inMax === inMin) return outMin;
  const raw = (value - inMin) / (inMax - inMin);
  return outMin + (outMax - outMin) * easing(Math.min(1, Math.max(0, raw)));
};
