"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Smoothly interpolate between the previous and current [lo, hi] domain
 * so a chart's axis re-scales with a 450 ms ease-out instead of snapping.
 * We only run the animation when the new bounds differ by more than ~20 %
 * from the current ones — for small shifts (toggling a tightly-clustered
 * value) the snap is imperceptible and the extra frames are wasted.
 *
 * Shared by `time-series-chart` (Y-axis after exclude / zoom) and
 * `distribution-chart` (X-axis when a landmark threshold is crossed).
 */
export function useAnimatedDomain(targetLo: number, targetHi: number) {
  const [displayed, setDisplayed] = useState({ lo: targetLo, hi: targetHi });
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const targetRange = Math.max(targetHi - targetLo, 1);
    const currentRange = Math.max(displayed.hi - displayed.lo, 1);
    const hiDelta = Math.abs(targetHi - displayed.hi) / Math.max(currentRange, 1);
    const loDelta = Math.abs(targetLo - displayed.lo) / Math.max(currentRange, 1);
    const rangeDelta = Math.abs(targetRange - currentRange) / currentRange;
    const significant = hiDelta > 0.2 || loDelta > 0.2 || rangeDelta > 0.2;

    if (!significant) {
      setDisplayed({ lo: targetLo, hi: targetHi });
      return;
    }

    const from = displayed;
    const to = { lo: targetLo, hi: targetHi };
    const start = performance.now();
    const duration = 450;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setDisplayed({
        lo: from.lo + (to.lo - from.lo) * e,
        hi: from.hi + (to.hi - from.hi) * e,
      });
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // displayed intentionally omitted: we only want to react to target changes
    // (the next animation frame will read the latest displayed value via closure).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetLo, targetHi]);

  return displayed;
}
