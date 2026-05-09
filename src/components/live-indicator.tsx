"use client";

import { useEffect, useState } from "react";

/**
 * Real-time freshness indicator for a bench: a pulsing green dot plus a
 * "Live · updated Ns ago" counter that ticks client-side every second.
 * Falls back to a muted "Stale" state if `lastRunAt` is older than 5 min,
 * which usually means the harness is down or ISR is wedged — better to
 * show staleness than to lie about freshness.
 */
export function LiveIndicator({ lastRunAt }: { lastRunAt: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const ageSec = Math.max(0, Math.floor((now - new Date(lastRunAt).getTime()) / 1000));
  const stale = ageSec > 300;

  return (
    <span className="inline-flex items-center gap-2 normal-case tracking-normal text-xs tabular text-ink-muted">
      <span className="relative flex h-2 w-2 items-center justify-center">
        {!stale && (
          <span
            className="absolute inset-0 rounded-full bg-good opacity-60 animate-ping"
            aria-hidden
          />
        )}
        <span
          className={`relative h-2 w-2 rounded-full ${stale ? "bg-ink-faint" : "bg-good"}`}
          aria-hidden
        />
      </span>
      <span className="font-medium" style={{ color: stale ? undefined : "var(--color-good)" }}>
        {stale ? "Stale" : "Live"}
      </span>
      <span className="text-ink-faint">·</span>
      <span>updated {formatAge(ageSec)} ago</span>
    </span>
  );
}

function formatAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
