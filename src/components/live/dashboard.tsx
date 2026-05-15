"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appendSwapToBuckets, cumulativePerChain, niceCeil } from "@/lib/live/buckets";
import { type ChainMeta, chainMeta } from "@/lib/live/chains";
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
  STORAGE_LIVE_EXPANDED,
} from "@/lib/live/config";
import type {
  Bucket,
  ChartPop,
  ChartSeries,
  GlobalView,
  RangeKey,
  RelayMessage,
  SwapEvent,
} from "@/lib/live/types";
import { LiveChart } from "./chart";
import { LiveTicker } from "./ticker";

type SeriesByRange = Record<RangeKey, ChartSeries>;

/** Best-effort runtime shape check on each WS frame. Mirrors the wire
 *  protocol documented in miniapps/ocb-stream-relay/README.md. Drops any
 *  message whose `type` is unknown or whose required fields are missing.
 *  Defense in depth: even if a relay regression sends garbage, the UI
 *  ignores it rather than crashing or rendering unexpected strings. */
function isRelayMessage(v: unknown): v is RelayMessage {
  if (typeof v !== "object" || v === null) return false;
  const m = v as { type?: unknown };
  if (m.type === "snapshot") {
    const s = v as { series?: unknown; nowMs?: unknown };
    return typeof s.nowMs === "number" && (s.series == null || typeof s.series === "object");
  }
  if (m.type === "swap") {
    const s = v as { chain?: unknown; usd?: unknown; side?: unknown };
    return (
      typeof s.chain === "string" &&
      typeof s.usd === "number" &&
      (s.side === "buy" || s.side === "sell")
    );
  }
  if (m.type === "stats") {
    const s = v as { global?: unknown; nowMs?: unknown };
    return typeof s.nowMs === "number" && typeof s.global === "object" && s.global !== null;
  }
  return false;
}

function emptySeries(): SeriesByRange {
  return {
    "10m": { windowMs: 10 * 60 * 1000, bucketMs: 5 * 1000, buckets: [] },
    "1h": { windowMs: 60 * 60 * 1000, bucketMs: 30 * 1000, buckets: [] },
    "24h": { windowMs: 24 * 60 * 60 * 1000, bucketMs: 10 * 60 * 1000, buckets: [] },
  };
}

export function LiveDashboard() {
  const [stats, setStats] = useState<GlobalView | null>(null);
  const [recent, setRecent] = useState<SwapEvent[]>([]);
  const [sessionSwaps, setSessionSwaps] = useState(0);
  const [connected, setConnected] = useState(false);
  const [series, setSeries] = useState<SeriesByRange>(emptySeries);
  const [pops, setPops] = useState<ChartPop[]>([]);
  const [hiddenChains, setHiddenChains] = useState<Set<string>>(new Set());
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [range, setRange] = useState<RangeKey>(DEFAULT_RANGE);

  const serverOffsetRef = useRef(0);
  const hiddenChainsRef = useRef<Set<string>>(new Set());
  const popIdRef = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectAttempts = useRef(0);
  const hiddenHydratedRef = useRef(false);
  const expandedHydratedRef = useRef(false);

  const toggleChain = useCallback((key: string) => {
    setHiddenChains((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);

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

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_LIVE_EXPANDED);
      if (saved === "1") setExpanded(true);
    } catch {
      // ignore
    }
    expandedHydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!expandedHydratedRef.current) return;
    try {
      window.localStorage.setItem(STORAGE_LIVE_EXPANDED, expanded ? "1" : "0");
    } catch {
      // ignore
    }
  }, [expanded]);

  useEffect(() => {
    let stopped = false;
    let ws: WebSocket | null = null;

    function scheduleReconnect() {
      if (stopped) return;
      // Exponential backoff with jitter. 2s → 4s → 8s → 16s → 30s (cap).
      // Without this, every browser tab hammers the relay in lockstep every
      // 2 s when it goes down — N tabs × every 2 s.
      reconnectAttempts.current += 1;
      const base = Math.min(30_000, 2_000 * 2 ** (reconnectAttempts.current - 1));
      const jitter = base * (0.75 + Math.random() * 0.5);
      reconnectTimer.current = window.setTimeout(connect, jitter);
    }

    function connect() {
      if (stopped) return;
      ws = new WebSocket(RELAY_WS_URL);

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
          // Forward-compat with the multi-resolution relay AND backward-compat
          // with the legacy `buckets`-only shape during deploy interleaving.
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
          const offset = msg.nowMs - Date.now();
          serverOffsetRef.current = offset;
          setServerOffsetMs(offset);
          return;
        }

        if (msg.type === "swap") {
          const s = msg;
          const meta = chainMeta(s.chain);
          if (!meta) return;

          setRecent((prev) => {
            const next = [s, ...prev];
            return next.length > MAX_FEED ? next.slice(0, MAX_FEED) : next;
          });
          setSessionSwaps((n) => n + 1);

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
              // Always anchor pops from the 10m view. anchor maths stays
              // simple and the pop is a floaty bubble so a minor offset
              // on longer ranges does not matter visually.
              spawnPop(next["10m"].buckets, meta, s);
            }
            return next;
          });
        } else if (msg.type === "stats") {
          setStats(msg.global);
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

  const activeSeries = useMemo(() => series[range], [series, range]);

  return (
    <>
      <LiveTicker
        connected={connected}
        stats={stats}
        sessionSwaps={sessionSwaps}
        expanded={expanded}
        onToggle={toggleExpanded}
      />
      {expanded && (
        <LiveChart
          series={activeSeries}
          range={range}
          onRangeChange={setRange}
          pops={pops}
          recent={recent}
          serverOffsetMs={serverOffsetMs}
          hiddenChains={hiddenChains}
          onToggleChain={toggleChain}
        />
      )}
    </>
  );
}
