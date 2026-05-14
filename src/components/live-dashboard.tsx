"use client";

import { useEffect, useRef, useState } from "react";
import { ProviderLogo } from "@/components/provider-logo";

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

type ChainBreakdown = { name: string; vol24h: number; trades24h: number };

type GlobalView = {
  vol24h: number;
  trades24h: number;
  buys24h: number;
  sells24h: number;
  fees24h: number;
  mcap: number;
  byChain: ChainBreakdown[];
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
const CHAIN_SLUGS: Record<string, { slug: string; display: string }> = {
  ethereum: { slug: "ethereum", display: "Ethereum" },
  Ethereum: { slug: "ethereum", display: "Ethereum" },
  solana: { slug: "solana", display: "Solana" },
  Solana: { slug: "solana", display: "Solana" },
  base: { slug: "base", display: "Base" },
  Base: { slug: "base", display: "Base" },
  bnb: { slug: "bnb", display: "BNB" },
  BNB: { slug: "bnb", display: "BNB" },
  BSC: { slug: "bnb", display: "BNB" },
  bsc: { slug: "bnb", display: "BNB" },
  "BNB Smart Chain (BEP20)": { slug: "bnb", display: "BNB" },
  "BNB Smart Chain": { slug: "bnb", display: "BNB" },
  arbitrum: { slug: "arbitrum", display: "Arbitrum" },
  Arbitrum: { slug: "arbitrum", display: "Arbitrum" },
  Optimism: { slug: "optimism", display: "Optimism" },
  optimism: { slug: "optimism", display: "Optimism" },
  Polygon: { slug: "polygon", display: "Polygon" },
  polygon: { slug: "polygon", display: "Polygon" },
  Avalanche: { slug: "avalanche", display: "Avalanche" },
  avalanche: { slug: "avalanche", display: "Avalanche" },
};

/** Only show chains we have a logo + recognizable display name for. */
function isKnownChain(name: string): boolean {
  return name in CHAIN_SLUGS;
}

type Pop = { id: number; amount: number; side: "buy" | "sell" };

export function LiveDashboard() {
  const [stats, setStats] = useState<GlobalView | null>(null);
  const [recent, setRecent] = useState<SwapEvent[]>([]);
  const [sessionSwaps, setSessionSwaps] = useState(0);
  const [sessionVol, setSessionVol] = useState(0);
  const [connected, setConnected] = useState(false);
  const [pops, setPops] = useState<Pop[]>([]);
  const [feedOpen, setFeedOpen] = useState(false);
  const reconnectTimer = useRef<number | null>(null);
  const popIdRef = useRef(0);

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
        let msg: SwapEvent | StatsTick;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === "swap") {
          const s = msg as SwapEvent;
          setRecent((prev) => {
            const next = [s, ...prev];
            return next.length > MAX_FEED ? next.slice(0, MAX_FEED) : next;
          });
          setSessionSwaps((n) => n + 1);
          setSessionVol((v) => v + (s.usd || 0));
          // Polymarket-style ephemeral increment overlay on the Vol tile.
          // Skip dust to avoid clutter — keep the "alive" cues meaningful.
          if (s.usd >= 1) {
            const id = ++popIdRef.current;
            setPops((prev) => [...prev, { id, amount: s.usd, side: s.side }]);
            window.setTimeout(() => {
              setPops((prev) => prev.filter((p) => p.id !== id));
            }, 1800);
          }
        } else if (msg.type === "stats") {
          setStats(msg.global);
        }
      };
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
        pops={pops}
        feedOpen={feedOpen}
        onToggleFeed={() => setFeedOpen((v) => !v)}
      />
      <ChainStrip stats={stats} />
      {feedOpen && <LiveFeed recent={recent} />}
    </>
  );
}

/* ---------- Status bar ---------- */

function StatusBar({ connected, stats }: { connected: boolean; stats: GlobalView | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const ageSec = stats?.lighthouseAt ? Math.max(0, Math.floor((now - stats.lighthouseAt) / 1000)) : -1;

  return (
    <div className="flex items-center gap-3 text-xs text-ink-muted mb-3">
      <span className="relative flex h-2 w-2">
        {connected && (
          <span className="absolute inset-0 rounded-full bg-good opacity-60 animate-ping" />
        )}
        <span
          className={`relative h-2 w-2 rounded-full ${
            connected ? "bg-good" : "bg-ink-faint"
          }`}
        />
      </span>
      <span
        className="font-medium uppercase tracking-[0.18em] text-[10px]"
        style={{ color: connected ? "var(--color-good)" : undefined }}
      >
        {connected ? "Streaming" : "Reconnecting…"}
      </span>
      <span className="text-ink-faint">·</span>
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
        Mobula fast-trade
      </span>
      {ageSec >= 0 && (
        <>
          <span className="ml-auto text-ink-faint">·</span>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
            Refreshed {fmtAge(ageSec)} ago
          </span>
        </>
      )}
    </div>
  );
}

/* ---------- Stats band (4 hero tiles) ---------- */

function StatsBand({
  stats,
  sessionSwaps,
  sessionVol,
  pops,
  feedOpen,
  onToggleFeed,
}: {
  stats: GlobalView | null;
  sessionSwaps: number;
  sessionVol: number;
  pops: Pop[];
  feedOpen: boolean;
  onToggleFeed: () => void;
}) {
  return (
    <div className="card grid grid-cols-2 sm:grid-cols-4 gap-px bg-rule overflow-hidden">
      <Tile
        label="Vol 24h"
        value={fmtMoney(stats?.vol24h)}
        sub="All chains · DEX trades"
        overlay={<PopOverlay pops={pops} />}
      />
      <Tile
        label="Txs 24h"
        value={fmtCount(stats?.trades24h)}
        sub={
          stats
            ? `${fmtCount(stats.buys24h)} buys · ${fmtCount(stats.sells24h)} sells`
            : "All chains"
        }
      />
      <Tile
        label="Market Cap"
        value={fmtMoney(stats?.mcap)}
        sub="All tracked assets"
      />
      <Tile
        label="Streamed live"
        value={sessionSwaps.toLocaleString()}
        sub={sessionVol > 0 ? `${fmtMoney(sessionVol)} streamed` : "This session"}
        emphasize
        onClick={onToggleFeed}
        action={feedOpen ? "Hide feed ▾" : "View feed ▸"}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  emphasize,
  overlay,
  onClick,
  action,
}: {
  label: string;
  value: string;
  sub: string;
  emphasize?: boolean;
  overlay?: React.ReactNode;
  onClick?: () => void;
  action?: string;
}) {
  const interactive = !!onClick;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      className={`relative flex flex-col gap-3 px-5 py-6 bg-surface min-w-0 overflow-hidden ${
        interactive ? "cursor-pointer hover:bg-paper-soft transition-colors" : ""
      }`}
    >
      <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted truncate">
        {label}
      </p>
      <p
        className={`display-num leading-none tabular truncate ${
          emphasize ? "text-3xl sm:text-4xl text-good" : "text-3xl sm:text-4xl text-ink"
        }`}
      >
        {value}
      </p>
      <p className="text-[11px] text-ink-muted leading-snug truncate">
        {sub}
        {action && (
          <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
            {action}
          </span>
        )}
      </p>
      {overlay}
    </div>
  );
}

/** Ephemeral floating "+$X" bubbles per swap. Polymarket-inspired. */
function PopOverlay({ pops }: { pops: Pop[] }) {
  if (pops.length === 0) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {pops.slice(-6).map((p) => (
        <PopBubble key={p.id} amount={p.amount} side={p.side} />
      ))}
    </div>
  );
}

function PopBubble({ amount, side }: { amount: number; side: "buy" | "sell" }) {
  // Random horizontal offset so multiple pops don't stack on top of each other.
  const left = useRef<number>(8 + Math.random() * 70);
  const fontSize = amount >= 100_000 ? 18 : amount >= 10_000 ? 15 : 12;
  const color = side === "buy" ? "var(--color-good)" : "var(--color-bad)";
  return (
    <span
      className="absolute pop-rise font-mono font-semibold tabular"
      style={{
        left: `${left.current}%`,
        bottom: "14%",
        color,
        fontSize: `${fontSize}px`,
        whiteSpace: "nowrap",
      }}
    >
      +{fmtMoney(amount)}
    </span>
  );
}

/* ---------- Per-chain breakdown ---------- */

function ChainStrip({ stats }: { stats: GlobalView | null }) {
  if (!stats?.byChain?.length) return null;
  const top = stats.byChain
    .filter((c) => isKnownChain(c.name) && c.vol24h > 0)
    .sort((a, b) => b.vol24h - a.vol24h)
    .slice(0, 6);
  if (!top.length) return null;
  const max = top[0]?.vol24h || 1;

  return (
    <div className="card mt-4 px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          Top chains · vol 24h
        </p>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
          {stats.byChain.length} chains tracked
        </p>
      </div>
      <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
        {top.map((c) => {
          const meta = CHAIN_SLUGS[c.name] ?? {
            slug: c.name.toLowerCase(),
            display: c.name,
          };
          const pct = Math.max(2, (c.vol24h / max) * 100);
          return (
            <li key={c.name} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <ProviderLogo slug={meta.slug} name={meta.display} size={18} />
                <span className="text-xs text-ink truncate font-medium">
                  {meta.display}
                </span>
              </div>
              <p className="font-mono tabular text-[11px] text-ink-soft">
                {fmtMoney(c.vol24h)}
              </p>
              <div className="h-1 bg-paper-soft rounded-full overflow-hidden">
                <div
                  className="h-full bg-ink/70 rounded-full transition-[width] duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ---------- Live feed ---------- */

function LiveFeed({ recent }: { recent: SwapEvent[] }) {
  return (
    <div className="card mt-4 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-rule">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          Live feed
        </span>
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inset-0 rounded-full bg-good opacity-60 animate-ping" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-good" />
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
          last {recent.length} swaps · scroll for more
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="ledger w-full">
          <thead>
            <tr>
              <th className="text-left px-4 py-2">Time</th>
              <th className="text-left px-2 py-2">Chain</th>
              <th className="text-left px-2 py-2">Pair</th>
              <th className="text-left px-2 py-2 hidden sm:table-cell">DEX</th>
              <th className="text-center px-2 py-2">Side</th>
              <th className="text-right px-2 py-2">USD</th>
              <th className="text-right px-2 py-2 hidden md:table-cell">Lag</th>
              <th className="text-left px-4 py-2 hidden md:table-cell">Tx</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-ink-faint py-10">
                  <span className="inline-flex items-center gap-2">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inset-0 rounded-full bg-good opacity-60 animate-ping" />
                      <span className="relative h-1.5 w-1.5 rounded-full bg-good" />
                    </span>
                    Listening for swaps…
                  </span>
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

  const meta = CHAIN_SLUGS[s.chain] ?? {
    slug: (s.chain || "").toLowerCase(),
    display: s.chain || "—",
  };

  const isBuy = s.side === "buy";
  const sideColor = isBuy ? "text-good" : "text-bad";
  const sideArrow = isBuy ? "▲" : "▼";

  // Whale highlights: $10k → semibold, $100k+ → bolder + warn color
  const isWhale = s.usd >= 100_000;
  const isBig = s.usd >= 10_000;
  const usdClass = isWhale
    ? "font-semibold text-warn"
    : isBig
      ? "font-semibold text-ink"
      : "text-ink";

  // Lag color scale (showcases provider speed)
  const lagClass =
    lag < 1000
      ? "text-good"
      : lag < 3000
        ? "text-warn"
        : "text-bad";

  return (
    <tr className={fresh ? "feed-fresh" : ""}>
      <td className="px-4 py-2 tabular text-[11px] text-ink-muted whitespace-nowrap">{time}</td>
      <td className="px-2 py-2">
        <span className="inline-flex items-center gap-2">
          <ProviderLogo slug={meta.slug} name={meta.display} size={16} />
          <span className="text-[11px] text-ink-soft hidden sm:inline">
            {meta.display}
          </span>
        </span>
      </td>
      <td className="px-2 py-2 text-ink text-[12px] whitespace-nowrap">{pair}</td>
      <td className="px-2 py-2 hidden sm:table-cell text-[11px] text-ink-soft whitespace-nowrap">
        {dex}
      </td>
      <td className={`px-2 py-2 text-center ${sideColor} font-semibold`}>{sideArrow}</td>
      <td className={`px-2 py-2 text-right tabular text-[12px] whitespace-nowrap ${usdClass}`}>
        {fmtMoney(s.usd)}
        {isWhale && <span className="ml-1 text-[9px]">🐋</span>}
      </td>
      <td className={`px-2 py-2 text-right tabular text-[11px] hidden md:table-cell ${lagClass}`}>
        {fmtLag(lag)}
      </td>
      <td className="px-4 py-2 hidden md:table-cell tabular text-[11px] text-ink-faint">
        {s.hash ? (
          <a
            href={txExplorerURL(s.chain, s.hash)}
            target="_blank"
            rel="noreferrer"
            className="hover:text-ink-soft transition-colors"
          >
            {s.hash.slice(0, 10)}…
          </a>
        ) : (
          ""
        )}
      </td>
    </tr>
  );
}

/* ---------- formatting helpers ---------- */

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

function fmtLag(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function txExplorerURL(chain: string, hash: string): string {
  const c = (chain || "").toLowerCase();
  if (c === "ethereum") return `https://etherscan.io/tx/${hash}`;
  if (c === "solana") return `https://solscan.io/tx/${hash}`;
  if (c === "base") return `https://basescan.org/tx/${hash}`;
  if (c === "bnb" || c === "bsc") return `https://bscscan.com/tx/${hash}`;
  if (c === "arbitrum") return `https://arbiscan.io/tx/${hash}`;
  return `#`;
}
