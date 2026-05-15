"use client";

import { useEffect, useState } from "react";

/**
 * Real-time freshness indicator for a bench: a pulsing green dot plus a
 * "Live · updated Ns ago" counter that ticks client-side every second.
 * Falls back to a muted "Stale" state if `lastRunAt` is older than 5 min,
 * which usually means the harness is down or ISR is wedged — better to
 * show staleness than to lie about freshness.
 *
 * Every page that renders this widget has its own ISR cycle, so the SSR
 * `lastRunAt` can drift across pages by a few seconds (home was rendered
 * at one cache miss, detail at another). To present a single canonical
 * value site-wide, when a `slug` is passed we re-fetch /api/citable on
 * mount and replace the SSR value with the API value. /api/citable is
 * edge-cached for 60 s so the network cost is amortised across viewers.
 */
export function LiveIndicator({
  lastRunAt,
  slug,
}: {
  lastRunAt: string;
  slug?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [canonical, setCanonical] = useState(lastRunAt);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;

    function fetchOnce() {
      fetch("/api/citable")
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { benchmarks?: { slug: string; asOf?: string }[] } | null) => {
          if (cancelled || !data?.benchmarks) return;
          const hit = data.benchmarks.find((b) => b.slug === slug);
          if (hit?.asOf) setCanonical(hit.asOf);
        })
        .catch(() => {
          // ignore — keep current value
        });
    }

    fetchOnce();
    // Re-poll every 30s so the canonical lastRunAt keeps up with Prom
    // freshness. Without this the counter ticks indefinitely against the
    // mount-time snapshot and slides into "Stale" even though Prom data
    // is fresh — the edge cache on /api/citable already coalesces calls.
    const id = setInterval(fetchOnce, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [slug]);

  const ageSec = Math.max(0, Math.floor((now - new Date(canonical).getTime()) / 1000));
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
