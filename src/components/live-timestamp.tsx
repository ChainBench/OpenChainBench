"use client";

import { useEffect, useState } from "react";

/**
 * Auto-updating "X seconds/minutes ago" timestamp. Renders the same string
 * the server produced on first paint so hydration matches, then re-formats
 * client-side every 15 seconds. Adds the live feel without re-fetching
 * data. the timestamps just keep ageing on screen.
 */
export function LiveTimestamp({ at, fallback }: { at: string; fallback: string }) {
  const [label, setLabel] = useState(fallback);

  useEffect(() => {
    const ts = new Date(at).getTime();
    if (!Number.isFinite(ts)) return;

    const update = () => setLabel(formatRelative(ts));
    update();
    const id = setInterval(update, 15_000);
    return () => clearInterval(id);
  }, [at]);

  return <span suppressHydrationWarning>{label}</span>;
}

function formatRelative(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
