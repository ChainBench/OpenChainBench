"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { appendSwapToBuckets, cumulativePerChain, niceCeil } from "@/lib/live/buckets";
import { type ChainMeta, chainMeta } from "@/lib/live/chains";
import {
  MAX_FEED,
  MAX_POPS,
  POP_DURATION_MS,
  POP_MIN_USD,
  RELAY_WS_URL,
  STORAGE_FEED_OPEN,
  STORAGE_HIDDEN_CHAINS,
  WINDOW_MS,
} from "@/lib/live/config";
import type {
  Bucket,
  ChartPop,
  GlobalView,
  RelayMessage,
  SwapEvent,
} from "@/lib/live/types";
import { LiveChart } from "./chart";
import { StatsBand } from "./stats-band";
import { StatusBar } from "./status-bar";

export function LiveDashboard() {
  const [stats, setStats] = useState<GlobalView | null>(null);
  const [recent, setRecent] = useState<SwapEvent[]>([]);
  const [sessionSwaps, setSessionSwaps] = useState(0);
  const [sessionVol, setSessionVol] = useState(0);
  const [connected, setConnected] = useState(false);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [pops, setPops] = useState<ChartPop[]>([]);
  const [feedOpen, setFeedOpen] = useState(true);
  const [hiddenChains, setHiddenChains] = useState<Set<string>>(new Set());
  const [serverOffsetMs, setServerOffsetMs] = useState(0);

  // Refs the WebSocket handler reads at message-time without rerunning.
  const serverOffsetRef = useRef(0);
  const hiddenChainsRef = useRef<Set<string>>(new Set());
  const popIdRef = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const feedHydratedRef = useRef(false);
  const hiddenHydratedRef = useRef(false);

  const toggleChain = useCallback((key: string) => {
    setHiddenChains((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleFeed = useCallback(() => setFeedOpen((v) => !v), []);

  // Restore hidden-chains from localStorage on mount.
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

  // Keep ref in sync + persist on change.
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

  // Feed open/close from localStorage. Default open; flip to closed only if
  // the user explicitly hid the feed before.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_FEED_OPEN);
      if (saved === "0") setFeedOpen(false);
    } catch {
      // ignore
    }
    feedHydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!feedHydratedRef.current) return;
    try {
      window.localStorage.setItem(STORAGE_FEED_OPEN, feedOpen ? "1" : "0");
    } catch {
      // ignore
    }
  }, [feedOpen]);

  // WebSocket loop.
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
          setSessionVol((v) => v + (s.usd || 0));

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

    function spawnPop(nextBuckets: Bucket[], meta: ChainMeta, s: SwapEvent, nowMs: number) {
      const last = nextBuckets[nextBuckets.length - 1];
      if (!last) return;
      const xMin = nowMs - WINDOW_MS;
      const anchorX = ((last.ts - xMin) / WINDOW_MS) * 100;

      // yMax matches the chart's: max CUMULATIVE per chain across the window.
      const cumPerChain = cumulativePerChain(nextBuckets);
      let yMax = 0;
      for (const k in cumPerChain) {
        if (cumPerChain[k] > yMax) yMax = cumPerChain[k];
      }
      yMax = niceCeil(yMax || 1);
      const chainCum = cumPerChain[meta.key] ?? 0;
      const anchorY = (1 - chainCum / yMax) * 100;

      const id = ++popIdRef.current;
      const pop: ChartPop = {
        id,
        chainKey: meta.key,
        pair: s.pair || meta.display,
        exchange: s.exchange || "",
        usd: s.usd || 0,
        side: s.side,
        anchorX: Math.max(0, Math.min(100, anchorX)),
        anchorY: Math.max(0, Math.min(95, anchorY)),
      };
      setPops((prev) => {
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
      <StatusBar connected={connected} stats={stats} />
      <StatsBand
        stats={stats}
        sessionSwaps={sessionSwaps}
        sessionVol={sessionVol}
        feedOpen={feedOpen}
        onToggleFeed={toggleFeed}
      />
      <LiveChart
        buckets={buckets}
        pops={pops}
        recent={recent}
        serverOffsetMs={serverOffsetMs}
        hiddenChains={hiddenChains}
        onToggleChain={toggleChain}
        onToggleFeed={toggleFeed}
        feedOpen={feedOpen}
      />
    </>
  );
}
