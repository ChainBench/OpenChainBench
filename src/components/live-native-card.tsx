"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Live native-token card for /chains/[slug]. Twin of the static
 * <KpiCard> but with:
 *   • 2 s polling against /api/chain/<slug>/live-prices
 *   • Flash background green/red on price up/down, fades over 600 ms
 *   • Direction chevron ↗ / ↘ on the most recent move
 *   • Mini sparkline of the last 30 ticks (≈ 60 s)
 *   • LIVE dot pulse + tooltip surfacing freshness
 *
 * Initial value is SSR-rendered from the parent so the card paints
 * instantly with no flicker. The polling kicks in after hydration.
 */

const POLL_MS = 2000;
const TICK_BUFFER = 30; // ~60 s of history at 2 s polling
const FLASH_MS = 600;

type LiveResp = {
  symbol: string | null;
  price: number | null;
  marketCap: number | null;
  volume24h: number | null;
  ts: number;
};

export function LiveNativeCard({
  slug,
  symbol,
  kind,
  initialValue,
  tip,
}: {
  slug: string;
  symbol: string;
  kind: "price" | "mcap";
  initialValue: number | null;
  tip: string;
}) {
  const [value, setValue] = useState<number | null>(initialValue);
  const [direction, setDirection] = useState<"up" | "down" | "flat">("flat");
  const [stale, setStale] = useState(false);
  // Seed the ticks buffer empty — the first useEffect poll stamps the
  // initial timestamp + value, keeping render pure (no Date.now during
  // component body).
  const [ticks, setTicks] = useState<{ ts: number; v: number }[]>([]);

  const prevRef = useRef<number | null>(initialValue);
  const flashTimer = useRef<number | null>(null);
  // 0 sentinel = "not yet seen"; real timestamp gets stamped inside
  // useEffect to avoid the impure-Date.now-during-render lint rule.
  const lastOkRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;
    let abort: AbortController | null = null;
    lastOkRef.current = Date.now();

    const poll = async () => {
      abort?.abort();
      abort = new AbortController();
      try {
        const res = await fetch(`/api/chain/${slug}/live-prices`, {
          signal: abort.signal,
          cache: "no-store",
        });
        if (!res.ok) {
          setStale(true);
          return;
        }
        const body = (await res.json()) as LiveResp;
        if (cancelled) return;
        const incoming = kind === "price" ? body.price : body.marketCap;
        if (incoming == null || !Number.isFinite(incoming)) {
          setStale(true);
          return;
        }
        const prev = prevRef.current;
        lastOkRef.current = Date.now();
        setStale(false);
        setValue(incoming);
        setTicks((prevTicks) => {
          const next = [
            ...prevTicks,
            { ts: body.ts, v: incoming },
          ].slice(-TICK_BUFFER);
          return next;
        });
        if (prev != null && Number.isFinite(prev)) {
          if (incoming > prev) setDirection("up");
          else if (incoming < prev) setDirection("down");
          if (incoming !== prev) {
            if (flashTimer.current) window.clearTimeout(flashTimer.current);
            flashTimer.current = window.setTimeout(() => {
              setDirection("flat");
            }, FLASH_MS) as unknown as number;
          }
        }
        prevRef.current = incoming;
      } catch {
        // network blip → mark stale, retry next tick
        setStale(true);
      }
    };

    // Mark stale if no successful poll in 8 s (network gone, server down).
    const staleWatcher = window.setInterval(() => {
      if (lastOkRef.current > 0 && Date.now() - lastOkRef.current > 8000) {
        setStale(true);
      }
    }, 2000);

    poll();
    const interval = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      abort?.abort();
      window.clearInterval(interval);
      window.clearInterval(staleWatcher);
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
    };
  }, [slug, kind]);

  const flashClass =
    direction === "up"
      ? "bg-emerald-100 dark:bg-emerald-950/40"
      : direction === "down"
        ? "bg-red-100 dark:bg-red-950/40"
        : "";

  const chevron =
    direction === "up" ? "↗" : direction === "down" ? "↘" : "";
  const chevronColor =
    direction === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : direction === "down"
        ? "text-red-600 dark:text-red-400"
        : "";

  return (
    <div
      className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 flex flex-col relative overflow-hidden"
      style={{ minHeight: 96 }}
      title={tip}
    >
      <div
        aria-hidden
        className={`absolute inset-0 pointer-events-none transition-colors duration-500 ${flashClass}`}
      />
      <div className="relative flex items-center justify-between gap-2">
        <p
          className="label-mono text-[10px] text-ink-faint uppercase tracking-wide leading-snug"
          style={{
            fontFamily: "var(--font-mono, monospace)",
            minHeight: 28,
          }}
        >
          {kind === "price" ? `${symbol} price` : `${symbol} market cap`}
        </p>
        <LiveDot stale={stale} />
      </div>
      <p className="mt-auto text-lg sm:text-xl font-semibold tabular-nums leading-tight relative flex items-baseline gap-1.5">
        <span>{value != null ? fmtUSD(value) : "—"}</span>
        {chevron && (
          <span className={`text-xs ${chevronColor} transition-opacity`}>
            {chevron}
          </span>
        )}
      </p>
      {ticks.length >= 3 && (
        <Sparkline ticks={ticks} direction={direction} />
      )}
    </div>
  );
}

function LiveDot({ stale }: { stale: boolean }) {
  return (
    <span
      className="relative inline-flex items-center"
      title={stale ? "Updates paused (no fresh data)" : "Live · refreshes every 2 s"}
    >
      <span
        className={`absolute inline-flex h-2 w-2 rounded-full opacity-75 ${
          stale ? "bg-amber-400" : "bg-emerald-500 animate-ping"
        }`}
      />
      <span
        className={`relative inline-flex h-2 w-2 rounded-full ${
          stale ? "bg-amber-500" : "bg-emerald-500"
        }`}
      />
    </span>
  );
}

function Sparkline({
  ticks,
  direction,
}: {
  ticks: { ts: number; v: number }[];
  direction: "up" | "down" | "flat";
}) {
  const { d, color } = useMemo(() => {
    const vals = ticks.map((t) => t.v);
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    const span = Math.max(1e-9, maxV - minV);
    const W = 200;
    const H = 28;
    const path = ticks
      .map((t, i) => {
        const x = (W * i) / Math.max(1, ticks.length - 1);
        const y = H - ((t.v - minV) / span) * H;
        return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
    const lastTwo = ticks.slice(-2);
    const overallUp =
      lastTwo.length === 2 ? lastTwo[1].v >= lastTwo[0].v : direction === "up";
    return {
      d: path,
      color: overallUp ? "#10b981" : "#ef4444",
    };
  }, [ticks, direction]);
  return (
    <svg
      viewBox="0 0 200 28"
      className="relative mt-1.5 w-full h-[24px]"
      preserveAspectRatio="none"
      aria-hidden
    >
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function fmtUSD(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000_000) return `$${(v / 1_000_000_000_000).toFixed(2)}T`;
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `$${v.toFixed(2)}`;
  if (abs >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toExponential(2)}`;
}
