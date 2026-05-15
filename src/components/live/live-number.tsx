"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Number that visibly increments between data snapshots.
 *
 * The relay pushes a fresh `stats` envelope every ~1 s. Without help, the
 * displayed number would jump in step-functions once per second — which
 * feels lifeless on a "live" ticker. We linearly extrapolate between the
 * last two snapshots:
 *
 *   1. Keep the last two (value, timestamp) pairs.
 *   2. Compute deltaPerMs = (lastValue - prevValue) / (lastTs - prevTs).
 *   3. On each animation frame, display lastValue + deltaPerMs * (now - lastTs).
 *
 * When a new snapshot arrives and it's HIGHER than where we extrapolated to
 * (the common case for monotonically-rising counters like vol24h, txs24h),
 * we just keep going. If it's lower or jumps, we snap to the new anchor —
 * the math has us correct itself the moment the next snapshot lands.
 *
 * `monotonic` mode never lets the displayed value go DOWN between renders,
 * even if the underlying value momentarily dips (e.g. a snapshot revision
 * from the upstream API). Helps avoid a "rolling backward" look that
 * confuses readers on a 24h rolling counter.
 */
export function LiveNumber({
  value,
  format,
  monotonic = false,
  className,
}: {
  value: number | undefined;
  format: (n: number | undefined) => string;
  monotonic?: boolean;
  className?: string;
}) {
  const [display, setDisplay] = useState<number | undefined>(value);
  const lastRef = useRef<{ value: number; ts: number } | null>(null);
  const prevRef = useRef<{ value: number; ts: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (value == null || !Number.isFinite(value)) return;
    const now = performance.now();
    prevRef.current = lastRef.current;
    lastRef.current = { value, ts: now };
  }, [value]);

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
