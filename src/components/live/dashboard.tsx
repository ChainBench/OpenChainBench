"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { appendSwapToBuckets, cumulativePerChain, niceCeil } from "@/lib/live/buckets";
import { type ChainMeta, chainMeta } from "@/lib/live/chains";
import {
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
  GlobalView,
  RelayMessage,
  SwapEvent,
} from "@/lib/live/types";
import { LiveChart } from "./chart";
import { LiveTicker } from "./ticker";

export function LiveDashboard() {
  const [stats, setStats] = useState<GlobalView | null>(null);
  const [recent, setRecent] = useState<SwapEvent[]>([]);
  const [sessionSwaps, setSessionSwaps] = useState(0);
  const [connected, setConnected] = useState(false);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [pops, setPops] = useState<ChartPop[]>([]);
  const [hiddenChains, setHiddenChains] = useState<Set<string>>(new Set());
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [expanded, setExpanded] = useState(false);

  const serverOffsetRef = useRef(0);
  const hiddenChainsRef = useRef<Set<string>>(new Set());
  const popIdRef = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
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

  // Hidden chains persisted across visits.
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

  // Expanded state persisted. Default collapsed.
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

    function connect() {
      if (stopped) return;
      ws = new WebSocket(RELAY_WS_URL);

      ws.onopen = () => setConnected(true);
      ws.onerror = () => ws?.close();
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) {
          reconnectTimer.current = window.setTimeout(connect, 2000);
        }
      };

      ws.onmessage = (e) => {
        let msg: RelayMessage;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }

        if (msg.type === "snapshot") {
          setBuckets(msg.buckets.slice());
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
          setBuckets((prev) => {
            const next = appendSwapToBuckets(prev, meta.key, s.usd || 0, serverNow);
            if (!isHidden && (s.usd || 0) >= POP_MIN_USD) spawnPop(next, meta, s, serverNow);
            return next;
          });
        } else if (msg.type === "stats") {
          setStats(msg.global);
        }
      };
    }

    function spawnPop(nextBuckets: Bucket[], meta: ChainMeta, s: SwapEvent, _nowMs: number) {
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
        // Stagger anchorY by the count of currently-active pops so they
        // don't collide at the right edge.
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
          buckets={buckets}
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
