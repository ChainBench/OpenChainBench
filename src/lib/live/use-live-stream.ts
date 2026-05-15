"use client";

/**
 * Shared WebSocket + state plumbing for live dashboards. Extracted from
 * `LiveDashboard` so multiple surfaces (home ticker, /networks dashboard)
 * can subscribe to the same relay protocol without duplicating the
 * connection logic, validation, or reconnect backoff.
 *
 * The hook owns:
 *   • connection lifecycle (open/close/reconnect with backoff)
 *   • wire-format validation (defense in depth against a hostile relay)
 *   • per-range bucket series + cumulative-per-chain stats
 *   • feed buffer (rolling MAX_FEED swaps)
 *   • pop overlay state (floating "+$X" bubbles)
 *   • hidden-chain persistence in localStorage
 *
 * Components read the returned values and call the returned mutators —
 * no other side-effects.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appendSwapToBuckets, cumulativePerChain, niceCeil } from "./buckets";
import { type ChainMeta, chainMeta } from "./chains";
import {
  DEFAULT_RANGE,
  MAX_FEED,
  MAX_POPS,
  POP_ANCHOR_X_PCT,
  POP_DURATION_MS,
  POP_MIN_USD,
  POP_STACK_OFFSET_PCT,
  RELAY_WS_URL,
  STORAGE_HIDDEN_CHAINS,
} from "./config";
import type {
  Bucket,
  ChartPop,
  ChartSeries,
  GlobalView,
  RangeKey,
  RelayMessage,
  SwapEvent,
} from "./types";

export type SeriesByRange = Record<RangeKey, ChartSeries>;

const MAX_STR = 128;
const MAX_USD = 1e12;
const MAX_BUCKETS_PER_RANGE = 2000;
const MAX_RANGE_KEYS = 8;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function isRelayMessage(v: unknown): v is RelayMessage {
  if (typeof v !== "object" || v === null) return false;
  const m = v as { type?: unknown };
  if (m.type === "snapshot") {
    const s = v as { series?: unknown; nowMs?: unknown };
    if (typeof s.nowMs !== "number" || !Number.isFinite(s.nowMs)) return false;
    if (s.series == null) return true;
    if (typeof s.series !== "object") return false;
    const series = s.series as Record<string, { buckets?: unknown }>;
    const keys = Object.keys(series);
    if (keys.length > MAX_RANGE_KEYS) return false;
    for (const r of Object.values(series)) {
      if (r && Array.isArray(r.buckets) && r.buckets.length > MAX_BUCKETS_PER_RANGE) {
        return false;
      }
    }
    return true;
  }
  if (m.type === "swap") {
    const s = v as {
      chain?: unknown;
      usd?: unknown;
      side?: unknown;
      pair?: unknown;
      exchange?: unknown;
    };
    if (typeof s.chain !== "string" || s.chain.length > MAX_STR) return false;
    if (typeof s.usd !== "number" || !Number.isFinite(s.usd) || s.usd < 0 || s.usd > MAX_USD) {
      return false;
    }
    if (s.side !== "buy" && s.side !== "sell") return false;
    if (s.pair != null && (typeof s.pair !== "string" || s.pair.length > MAX_STR)) return false;
    if (s.exchange != null && (typeof s.exchange !== "string" || s.exchange.length > MAX_STR)) {
      return false;
    }
    return true;
  }
  if (m.type === "stats") {
    const s = v as { global?: unknown; nowMs?: unknown };
    if (typeof s.nowMs !== "number" || !Number.isFinite(s.nowMs)) return false;
    return typeof s.global === "object" && s.global !== null;
  }
  return false;
}

export function emptySeries(): SeriesByRange {
  return {
    "10m": { windowMs: 10 * 60 * 1000, bucketMs: 5 * 1000, buckets: [] },
    "1h": { windowMs: 60 * 60 * 1000, bucketMs: 30 * 1000, buckets: [] },
    "24h": { windowMs: 24 * 60 * 60 * 1000, bucketMs: 10 * 60 * 1000, buckets: [] },
  };
}

export type LiveStream = {
  connected: boolean;
  stats: GlobalView | null;
  recent: SwapEvent[];
  series: SeriesByRange;
  pops: ChartPop[];
  hiddenChains: Set<string>;
  serverOffsetMs: number;
  range: RangeKey;
  setRange: (r: RangeKey) => void;
  toggleChain: (key: string) => void;
  /** Total streamed USD since this hook mounted (sum of all observed swaps). */
  streamedUsd: number;
  /** Count of swaps observed since this hook mounted. */
  streamedCount: number;
  /** Number of swaps in the last 10 seconds — handy for "+24" indicators. */
  recent10sCount: number;
  /** Client-ms when the most recent stats tick arrived from the relay. */
  lastStatsAt: number | null;
};

export function useLiveStream(): LiveStream {
  const [stats, setStats] = useState<GlobalView | null>(null);
  const [recent, setRecent] = useState<SwapEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [series, setSeries] = useState<SeriesByRange>(emptySeries);
  const [pops, setPops] = useState<ChartPop[]>([]);
  const [hiddenChains, setHiddenChains] = useState<Set<string>>(new Set());
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [range, setRange] = useState<RangeKey>(DEFAULT_RANGE);
  const [streamedUsd, setStreamedUsd] = useState(0);
  const [streamedCount, setStreamedCount] = useState(0);
  const [recent10sCount, setRecent10sCount] = useState(0);
  const [lastStatsAt, setLastStatsAt] = useState<number | null>(null);

  const serverOffsetRef = useRef(0);
  const hiddenChainsRef = useRef<Set<string>>(new Set());
  const popIdRef = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectAttempts = useRef(0);
  const hiddenHydratedRef = useRef(false);
  // Rolling buffer of recent swap timestamps for the "+N in last 10s" pill.
  const recentTimesRef = useRef<number[]>([]);

  const toggleChain = useCallback((key: string) => {
    setHiddenChains((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_HIDDEN_CHAINS);
      if (saved) {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr)) setHiddenChains(new Set(arr));
      }
    } catch {
      // ignore
    }
    hiddenHydratedRef.current = true;
  }, []);

  useEffect(() => {
    hiddenChainsRef.current = hiddenChains;
    if (!hiddenHydratedRef.current) return;
    try {
      window.localStorage.setItem(
        STORAGE_HIDDEN_CHAINS,
        JSON.stringify(Array.from(hiddenChains)),
      );
    } catch {
      // ignore
    }
  }, [hiddenChains]);

  // Tick the "+N last 10s" counter once a second so old entries drop off.
  useEffect(() => {
    const id = setInterval(() => {
      const cutoff = Date.now() - 10_000;
      const arr = recentTimesRef.current;
      while (arr.length > 0 && arr[0] < cutoff) arr.shift();
      setRecent10sCount(arr.length);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let stopped = false;
    let ws: WebSocket | null = null;

    function scheduleReconnect() {
      if (stopped) return;
      if (reconnectTimer.current != null) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      reconnectAttempts.current += 1;
      const base = Math.min(30_000, 2_000 * 2 ** (reconnectAttempts.current - 1));
      const jitter = base * (0.75 + Math.random() * 0.5);
      reconnectTimer.current = window.setTimeout(connect, jitter);
    }

    function connect() {
      if (stopped) return;
      try {
        ws = new WebSocket(RELAY_WS_URL);
      } catch {
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        setConnected(true);
        reconnectAttempts.current = 0;
      };
      ws.onerror = () => ws?.close();
      ws.onclose = () => {
        setConnected(false);
        scheduleReconnect();
      };

      ws.onmessage = (e) => {
        if (typeof e.data !== "string" || e.data.length > 64 * 1024) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(e.data);
        } catch {
          return;
        }
        if (!isRelayMessage(parsed)) return;
        const msg: RelayMessage = parsed;

        if (msg.type === "snapshot") {
          const fallback = emptySeries();
          const legacy = (msg as unknown as { buckets?: Bucket[] }).buckets;
          const next: SeriesByRange = msg.series
            ? {
                "10m": msg.series["10m"] ?? fallback["10m"],
                "1h": msg.series["1h"] ?? fallback["1h"],
                "24h": msg.series["24h"] ?? fallback["24h"],
              }
            : legacy
              ? { ...fallback, "10m": { ...fallback["10m"], buckets: legacy } }
              : fallback;
          setSeries(next);
          const rawOffset = msg.nowMs - Date.now();
          const offset = Math.max(-MAX_CLOCK_SKEW_MS, Math.min(MAX_CLOCK_SKEW_MS, rawOffset));
          serverOffsetRef.current = offset;
          setServerOffsetMs(offset);
          return;
        }

        if (msg.type === "swap") {
          const s = msg;
          const meta = chainMeta(s.chain);
          if (!meta) return;

          // Track session-streamed totals + 10 s rolling count.
          setStreamedUsd((u) => u + (s.usd || 0));
          setStreamedCount((c) => c + 1);
          recentTimesRef.current.push(Date.now());
          // Keep buffer bounded — 10s × ~50/s peak ≈ 500.
          if (recentTimesRef.current.length > 1000) recentTimesRef.current.shift();

          setRecent((prev) => {
            const next = [s, ...prev];
            return next.length > MAX_FEED ? next.slice(0, MAX_FEED) : next;
          });

          const serverNow = Date.now() + serverOffsetRef.current;
          const isHidden = hiddenChainsRef.current.has(meta.key);
          setSeries((prev) => {
            const next: SeriesByRange = { ...prev };
            (Object.keys(prev) as RangeKey[]).forEach((key) => {
              const r = prev[key];
              next[key] = {
                ...r,
                buckets: appendSwapToBuckets(
                  r.buckets,
                  meta.key,
                  s.usd || 0,
                  serverNow,
                  r.bucketMs,
                  r.windowMs,
                ),
              };
            });
            if (!isHidden && (s.usd || 0) >= POP_MIN_USD) {
              spawnPop(next["10m"].buckets, meta, s);
            }
            return next;
          });
        } else if (msg.type === "stats") {
          setStats(msg.global);
          setLastStatsAt(Date.now());
        }
      };
    }

    function spawnPop(nextBuckets: Bucket[], meta: ChainMeta, s: SwapEvent) {
      const last = nextBuckets[nextBuckets.length - 1];
      if (!last) return;

      const cumPerChain = cumulativePerChain(nextBuckets);
      let yMax = 0;
      for (const k in cumPerChain) {
        if (cumPerChain[k] > yMax) yMax = cumPerChain[k];
      }
      yMax = niceCeil(yMax || 1);
      const chainCum = cumPerChain[meta.key] ?? 0;
      const baseY = (1 - chainCum / yMax) * 100;

      const id = ++popIdRef.current;
      setPops((prev) => {
        const slot = prev.length % MAX_POPS;
        const anchorY = Math.max(2, Math.min(88, baseY + slot * POP_STACK_OFFSET_PCT));
        const pop: ChartPop = {
          id,
          chainKey: meta.key,
          pair: s.pair || meta.display,
          exchange: s.exchange || "",
          usd: s.usd || 0,
          side: s.side,
          anchorX: POP_ANCHOR_X_PCT,
          anchorY,
        };
        const next = [...prev, pop];
        return next.length > MAX_POPS ? next.slice(-MAX_POPS) : next;
      });
      window.setTimeout(() => {
        setPops((prev) => prev.filter((p) => p.id !== id));
      }, POP_DURATION_MS);
    }

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      ws?.close();
    };
  }, []);

  return useMemo(
    () => ({
      connected,
      stats,
      recent,
      series,
      pops,
      hiddenChains,
      serverOffsetMs,
      range,
      setRange,
      toggleChain,
      streamedUsd,
      streamedCount,
      recent10sCount,
      lastStatsAt,
    }),
    [
      connected,
      stats,
      recent,
      series,
      pops,
      hiddenChains,
      serverOffsetMs,
      range,
      toggleChain,
      streamedUsd,
      streamedCount,
      recent10sCount,
      lastStatsAt,
    ],
  );
}
