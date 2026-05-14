"use client";

import { useEffect, useState } from "react";
import { LiveDot } from "@/components/live-dot";
import { fmtAge } from "@/lib/live/format";
import type { GlobalView } from "@/lib/live/types";

export function StatusBar({
  connected,
  stats,
  onCollapse,
}: {
  connected: boolean;
  stats: GlobalView | null;
  onCollapse?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const ageSec = stats?.lighthouseAt
    ? Math.max(0, Math.floor((now - stats.lighthouseAt) / 1000))
    : -1;

  return (
    <div className="flex items-center gap-3 text-xs text-ink-muted mb-3">
      {connected ? (
        <LiveDot className="h-2 w-2" />
      ) : (
        <span className="h-2 w-2 rounded-full bg-ink-faint" />
      )}
      <span
        className="label-mono"
        style={{ color: connected ? "var(--color-good)" : undefined }}
      >
        {connected ? "Streaming" : "Reconnecting…"}
      </span>
      <span className="text-ink-faint">·</span>
      <span className="label-mono text-ink-faint">Mobula fast-trade</span>
      {ageSec >= 0 && (
        <>
          <span className="ml-auto text-ink-faint">·</span>
          <span className="label-mono text-ink-faint">
            Refreshed {fmtAge(ageSec)} ago
          </span>
        </>
      )}
      {onCollapse && (
        <button
          type="button"
          onClick={onCollapse}
          className={`label-mono text-ink-faint hover:text-ink transition-colors ${
            ageSec >= 0 ? "" : "ml-auto"
          }`}
        >
          Collapse ▴
        </button>
      )}
    </div>
  );
}
