"use client";

import { useEffect, useRef, useState } from "react";

const RELAY_WS_URL =
  process.env.NEXT_PUBLIC_RELAY_WS_URL ??
  "wss://ocb-stream-relay-production.up.railway.app/ws";

type SwapEvent = {
  type: "swap";
  chain: string;
  pool: string;
  pair: string;
  exchange: string;
  side: "buy" | "sell";
  usd: number;
  hash: string;
  onChainMs: number;
  mobulaMs: number;
  receivedMs: number;
};

type GlobalView = {
  vol24h: number;
  trades24h: number;
  buys24h: number;
  sells24h: number;
  fees24h: number;
  mcap: number;
  byChain: { name: string; vol24h: number; trades24h: number }[];
  lighthouseAt: number;
  mcapAt: number;
};

type StatsTick = {
  type: "stats";
  global: GlobalView;
  live: { swaps: number; vol: number; chains: number };
  nowMs: number;
};

const MAX_FEED = 30;

export function LiveDashboard() {
  const [stats, setStats] = useState<GlobalView | null>(null);
  const [recent, setRecent] = useState<SwapEvent[]>([]);
  const [sessionSwaps, setSessionSwaps] = useState(0);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);

  useEffect(() => {
    let stopped = false;

    function connect() {
      if (stopped) return;
      const ws = new WebSocket(RELAY_WS_URL);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onclose = () => {
        setConnected(false);
        if (!stopped) {
          reconnectTimer.current = window.setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => ws.close();

      ws.onmessage = (e) => {
        let msg: SwapEvent | StatsTick;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === "swap") {
          setRecent((prev) => {
            const next = [msg as SwapEvent, ...prev];
            return next.length > MAX_FEED ? next.slice(0, MAX_FEED) : next;
          });
          setSessionSwaps((n) => n + 1);
        } else if (msg.type === "stats") {
          setStats(msg.global);
        }
      };
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  return (
    <>
      <StatsBand stats={stats} sessionSwaps={sessionSwaps} connected={connected} />
      <LiveFeed recent={recent} />
    </>
  );
}

function StatsBand({
  stats,
  sessionSwaps,
  connected,
}: {
  stats: GlobalView | null;
  sessionSwaps: number;
  connected: boolean;
}) {
  return (
    <div className="card grid grid-cols-2 sm:grid-cols-4 gap-px bg-rule overflow-hidden">
      <Tile
        label="Vol 24h"
        value={fmtMoney(stats?.vol24h)}
        caption="all chains · 5min refresh"
        live={connected}
      />
      <Tile
        label="Txs 24h"
        value={fmtCount(stats?.trades24h)}
        caption="all chains · 5min refresh"
        live={connected}
      />
      <Tile
        label="Market Cap"
        value={fmtMoney(stats?.mcap)}
        caption="all assets · 10min refresh"
        live={connected}
      />
      <Tile
        label="Swaps streamed"
        value={sessionSwaps.toLocaleString()}
        caption={connected ? "this session · live" : "reconnecting…"}
        live={connected}
        pulse
      />
    </div>
  );
}

function Tile({
  label,
  value,
  caption,
  live,
  pulse,
}: {
  label: string;
  value: string;
  caption: string;
  live: boolean;
  pulse?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 px-5 py-5 bg-surface min-w-0">
      <div className="flex items-center gap-2">
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-muted truncate">
          {label}
        </p>
        {live && (
          <span className="relative inline-flex h-1.5 w-1.5">
            {pulse && (
              <span className="absolute inset-0 rounded-full bg-good opacity-60 animate-ping" />
            )}
            <span className="relative h-1.5 w-1.5 rounded-full bg-good" />
          </span>
        )}
      </div>
      <p className="display-num text-2xl sm:text-3xl leading-none tabular truncate">
        {value}
      </p>
      <p className="text-xs text-ink-muted leading-snug">{caption}</p>
    </div>
  );
}

function LiveFeed({ recent }: { recent: SwapEvent[] }) {
  return (
    <div className="card mt-6 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-rule">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          Live feed
        </span>
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inset-0 rounded-full bg-good opacity-60 animate-ping" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-good" />
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
          {recent.length}/{MAX_FEED} swaps
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="ledger w-full">
          <thead>
            <tr>
              <th className="text-left">Time</th>
              <th className="text-left">Chain</th>
              <th className="text-left">Pair</th>
              <th className="text-left hidden sm:table-cell">DEX</th>
              <th className="text-left">Side</th>
              <th className="text-right">USD</th>
              <th className="text-right hidden md:table-cell">Lag</th>
              <th className="text-left hidden md:table-cell">Tx</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-ink-faint py-8">
                  Waiting for swaps…
                </td>
              </tr>
            )}
            {recent.map((s, i) => (
              <FeedRow key={s.hash + s.pool + i} s={s} fresh={i === 0} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FeedRow({ s, fresh }: { s: SwapEvent; fresh: boolean }) {
  const lag = Math.max(0, s.receivedMs - s.onChainMs);
  const pair = s.pair || (s.pool ? s.pool.slice(0, 8) + "…" : "—");
  const dex = s.exchange || "—";
  const time = new Date(s.receivedMs).toISOString().slice(11, 19);
  const sideColor = s.side === "buy" ? "text-good" : "text-bad";
  return (
    <tr className={fresh ? "feed-fresh" : ""}>
      <td className="tabular text-ink-muted">{time}</td>
      <td className="uppercase text-ink-soft">{s.chain}</td>
      <td className="text-ink">{pair}</td>
      <td className="hidden sm:table-cell text-ink-soft">{dex}</td>
      <td className={`${sideColor} font-semibold`}>
        {s.side === "buy" ? "▲" : "▼"}
      </td>
      <td className="text-right tabular text-ink">{fmtMoney(s.usd)}</td>
      <td className="hidden md:table-cell text-right tabular text-ink-muted">
        {lag.toLocaleString()}ms
      </td>
      <td className="hidden md:table-cell tabular text-ink-faint">
        {s.hash ? s.hash.slice(0, 10) + "…" : ""}
      </td>
    </tr>
  );
}

function fmtMoney(n: number | undefined): string {
  if (n == null || n <= 0) return "—";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtCount(n: number | undefined): string {
  if (n == null || n < 0) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}
