"use client";

import { useEffect, useState } from "react";

/**
 * Slim status row above the KPI strip. Mirrors the "STREAMING • MOBULA
 * FAST-TRADE • REFRESHED Xm AGO" line in the target design. Uses the
 * relay's `serverOffsetMs` so the "refreshed" age is calibrated to the
 * server clock instead of the (possibly skewed) browser clock.
 */
export function StatusBar({
  connected,
  lastSnapshotAt,
}: {
  connected: boolean;
  /** When the most recent snapshot/stats arrived, in client ms. */
  lastSnapshotAt: number | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const ageLabel = (() => {
    if (lastSnapshotAt == null) return "Connecting…";
    const sec = Math.max(0, Math.floor((now - lastSnapshotAt) / 1000));
    if (sec < 60) return `Refreshed ${sec}s ago`;
    const m = Math.floor(sec / 60);
    return `Refreshed ${m}m ago`;
  })();

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-ink-muted">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-good" : "bg-ink-faint"}`}
          aria-hidden
        />
        <span className="label-mono" style={{ color: connected ? "var(--color-good)" : undefined }}>
          {connected ? "Streaming" : "Reconnecting"}
        </span>
        <span className="text-ink-faint" aria-hidden>·</span>
        <span className="label-mono text-ink-muted">Mobula fast-trade</span>
      </div>
      <span className="label-mono text-ink-faint">{ageLabel}</span>
    </div>
  );
}
