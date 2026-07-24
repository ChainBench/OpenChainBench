"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Number that visibly increments between data snapshots.
 *
 * The relay broadcasts `stats` every ~1 s but only re-polls Mobula's
 * lighthouse every few minutes, so most 1 s pushes carry the SAME
 * trades24h / vol24h values. Naive snapshot pairing (last two pushes)
 * sees delta=0 and freezes the counter between polls, then makes it
 * jump every few minutes - exactly the lifeless behavior we want to
 * avoid.
 *
 * Fix: track only DISTINCT value transitions. The span between two
 * distinct values (typically the lighthouse refresh interval) gives a
 * meaningful rate that extrapolates smoothly through the next gap. So:
 *
 *   1. Keep the last two (value, timestamp) pairs that actually changed.
 *   2. deltaPerMs = (lastValue - prevValue) / (lastTs - prevTs).
 *   3. On each animation frame: display lastValue + deltaPerMs * (now - lastTs).
 *
 * `monotonic` mode never lets the displayed value go DOWN between
 * renders, even if the underlying value momentarily dips (e.g. a
 * snapshot revision from the upstream API).
 */
export function LiveNumber({
  value,
  format,
  monotonic = false,
  maxValue,
  className,
}: {
  value: number | undefined;
  format: (n: number | undefined) => string;
  monotonic?: boolean;
  /** Defensive ceiling. A single garbage push from the upstream relay
   *  (observed: onchain vol24h briefly returning 8e79) would otherwise
   *  latch into `lastRef` and, under `monotonic`, stick as the
   *  displayed value forever because every subsequent healthy push is
   *  smaller and gets rejected as a "down tick". Reject any incoming
   *  value above the ceiling before it can pollute the snapshot pair. */
  maxValue?: number;
  className?: string;
}) {
  // Never SEED the display with a value that already exceeds the
  // ceiling. Otherwise the very first render (before any useEffect runs)
  // would paint the garbage, then the monotonic guard would reject
  // every healthy value that follows as a "down tick" and the garbage
  // would stick until the tab was closed.
  const seed =
    value == null || (maxValue != null && value > maxValue) ? undefined : value;
  const [display, setDisplay] = useState<number | undefined>(seed);
  const lastRef = useRef<{ value: number; ts: number } | null>(null);
  const prevRef = useRef<{ value: number; ts: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (value == null || !Number.isFinite(value)) return;
    if (maxValue != null && value > maxValue) {
      // Flush a poisoned lastRef AND the displayed value so a healthy
      // push can seed the ticker fresh on the next tick. Without
      // resetting `display`, the monotonic guard below would keep
      // rejecting the healthy value as smaller than the garbage still
      // shown to the user.
      if (lastRef.current && lastRef.current.value > maxValue) {
        lastRef.current = null;
        prevRef.current = null;
      }
      setDisplay((d) =>
        d != null && maxValue != null && d > maxValue ? undefined : d,
      );
      return;
    }
    const now = performance.now();
    // Only advance the snapshot pair on DISTINCT values. Consecutive pushes
    // with the same value (relay 1 Hz tick × lighthouse 1-5 min poll) would
    // otherwise collapse the delta to zero and freeze the counter.
    if (!lastRef.current) {
      lastRef.current = { value, ts: now };
      return;
    }
    if (lastRef.current.value === value) return;
    prevRef.current = lastRef.current;
    lastRef.current = { value, ts: now };
  }, [value, maxValue]);

  useEffect(() => {
    let cancelled = false;

    function tick() {
      if (cancelled) return;
      const last = lastRef.current;
      const prev = prevRef.current;
      if (!last) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const now = performance.now();
      let next = last.value;
      if (prev) {
        const span = last.ts - prev.ts;
        if (span > 0) {
          const rate = (last.value - prev.value) / span;
          const projected = last.value + rate * (now - last.ts);
          // Don't extrapolate further than the duration of the last gap
          // so a stale connection doesn't drift the number unboundedly.
          const cap = last.value + (last.value - prev.value) * 2;
          next = rate > 0 ? Math.min(projected, cap) : projected;
        }
      }
      if (monotonic) {
        setDisplay((prevDisplay) =>
          prevDisplay != null && next < prevDisplay ? prevDisplay : next,
        );
      } else {
        setDisplay(next);
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [monotonic]);

  return <span className={className}>{format(display)}</span>;
}
