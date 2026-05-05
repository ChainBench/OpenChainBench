"use client";

import { useEffect, useState } from "react";

/**
 * Tiny ticker that says "live · next sample in Ns" and counts down to the
 * next ISR window. Resets every 60s. Purely decorative — the actual data
 * refresh is handled by Next.js ISR. Gives the page a heartbeat.
 */
export function RefreshPulse({ intervalSeconds = 60 }: { intervalSeconds?: number }) {
  const [secondsLeft, setSecondsLeft] = useState(intervalSeconds);

  useEffect(() => {
    const id = setInterval(() => {
      setSecondsLeft((s) => (s <= 1 ? intervalSeconds : s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [intervalSeconds]);

  return (
    <span
      className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted"
      suppressHydrationWarning
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full bg-good animate-pulse"
        aria-hidden
      />
      Live · next sample in {secondsLeft}s
    </span>
  );
}
