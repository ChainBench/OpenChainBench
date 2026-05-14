"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ProviderLogo } from "@/components/provider-logo";

const RELAY_WS_URL =
  process.env.NEXT_PUBLIC_RELAY_WS_URL ??
  "wss://ocb-stream-relay-production.up.railway.app/ws";

/* ─────────────── types from the relay ─────────────── */

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

type SnapshotMsg = {
  type: "snapshot";
  buckets: { ts: number; perChain: Record<string, number> }[];
  nowMs: number;
};

/* ─────────────── chain catalog (display + colors) ─────────────── */

type ChainMeta = { key: string; slug: string; display: string; color: string };

const CHAIN_LIST: ChainMeta[] = [
  { key: "ethereum", slug: "ethereum", display: "Ethereum", color: "#627EEA" },
  { key: "solana", slug: "solana", display: "Solana", color: "#9945FF" },
  { key: "base", slug: "base", display: "Base", color: "#0052FF" },
  { key: "bnb", slug: "bnb", display: "BNB", color: "#F0B90B" },
  { key: "arbitrum", slug: "arbitrum", display: "Arbitrum", color: "#28A0F0" },
];

const CHAIN_BY_INPUT: Record<string, ChainMeta> = (() => {
  const m: Record<string, ChainMeta> = {};
  for (const c of CHAIN_LIST) {
    m[c.key] = c;
    m[c.display] = c;
    m[c.display.toLowerCase()] = c;
  }
  // aliases
  m.bsc = CHAIN_LIST.find((c) => c.key === "bnb")!;
  m.BSC = m.bsc;
  m["BNB Smart Chain"] = m.bsc;
  m["BNB Smart Chain (BEP20)"] = m.bsc;
  return m;
})();

function chainMeta(raw: string | undefined): ChainMeta | null {
  if (!raw) return null;
  return CHAIN_BY_INPUT[raw] ?? null;
}

/* ─────────────── time-series bucket store ─────────────── */

const WINDOW_MS = 10 * 60 * 1000; // 10 min
const BUCKET_MS = 5 * 1000; // 5 s
const MAX_POPS = 8;

type Bucket = { ts: number; perChain: Record<string, number> };

/** Buckets hold INCREMENTAL vol per 5s window per chain (NOT cumulative).
 *  The chart computes cumulative on the fly at render time so when the window
 *  slides, dropping the oldest bucket naturally re-bases the line at 0. */
function appendSwapToBuckets(prev: Bucket[], chainKey: string, usd: number, nowMs: number): Bucket[] {
  const bucketTs = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS;
  const buckets = [...prev];
  const last = buckets[buckets.length - 1];

  if (last && bucketTs > last.ts + BUCKET_MS) {
    for (let t = last.ts + BUCKET_MS; t < bucketTs; t += BUCKET_MS) {
      buckets.push({ ts: t, perChain: {} });
    }
  }

  if (last && last.ts === bucketTs) {
    const upd = { ts: last.ts, perChain: { ...last.perChain } };
    upd.perChain[chainKey] = (upd.perChain[chainKey] ?? 0) + usd;
    buckets[buckets.length - 1] = upd;
  } else {
    buckets.push({ ts: bucketTs, perChain: { [chainKey]: usd } });
  }

  const cutoff = nowMs - WINDOW_MS;
  while (buckets.length > 0 && buckets[0].ts < cutoff) {
    buckets.shift();
  }
  return buckets;
}

/* ─────────────── component ─────────────── */

type ChartPop = {
  id: number;
  chainKey: string;
  pair: string;
  exchange: string;
  usd: number;
  side: "buy" | "sell";
  anchorX: number; // 0–100% of chart width
  anchorY: number; // 0–100% of chart height
};

export function LiveDashboard() {
  const [stats, setStats] = useState<GlobalView | null>(null);
  const [recent, setRecent] = useState<SwapEvent[]>([]);
  const [sessionSwaps, setSessionSwaps] = useState(0);
  const [sessionVol, setSessionVol] = useState(0);
  const [connected, setConnected] = useState(false);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [pops, setPops] = useState<ChartPop[]>([]);
  const [feedOpen, setFeedOpen] = useState(true);
  const feedHydratedRef = useRef(false);

  // Restore the user's last choice from localStorage. We default to OPEN and
  // only swap to closed if they explicitly hid the feed before.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("ocb-live-feed-open");
      if (saved === "0") setFeedOpen(false);
    } catch {
      // ignore (private browsing / quota / etc.)
    }
    feedHydratedRef.current = true;
  }, []);

  // Persist toggles. Skip the initial mount so we don't clobber whatever was
  // saved before the hydration effect has run.
  useEffect(() => {
    if (!feedHydratedRef.current) return;
    try {
      window.localStorage.setItem("ocb-live-feed-open", feedOpen ? "1" : "0");
    } catch {
      // ignore
    }
  }, [feedOpen]);

  const popIdRef = useRef(0);
  const reconnectTimer = useRef<number | null>(null);

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
        let msg: SwapEvent | StatsTick | SnapshotMsg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }

        if (msg.type === "snapshot") {
          // Server-replayed last 10min of incremental buckets — initial fill.
          setBuckets(msg.buckets.slice());
          return;
        }

        if (msg.type === "swap") {
          const s = msg as SwapEvent;
          const meta = chainMeta(s.chain);
          if (!meta) return; // skip non-tracked chains

          setRecent((prev) => {
            const next = [s, ...prev];
            return next.length > 50 ? next.slice(0, 50) : next;
          });
          setSessionSwaps((n) => n + 1);
          setSessionVol((v) => v + (s.usd || 0));

          // Buckets + pops
          const now = Date.now();
          setBuckets((prev) => {
            const next = appendSwapToBuckets(prev, meta.key, s.usd || 0, now);
            // Spawn pop after we know the line tip position.
            if ((s.usd || 0) >= 1) spawnPop(next, meta, s);
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
      const now = Date.now();
      const xMin = now - WINDOW_MS;
      const anchorX = ((last.ts - xMin) / WINDOW_MS) * 100;

      // Compute yMax across all chains in this final view, just like the chart does
      let yMax = 0;
      for (const b of nextBuckets) {
        for (const v of Object.values(b.perChain)) {
          if (v > yMax) yMax = v;
        }
      }
      if (yMax === 0) yMax = 1;
      const chainCum = last.perChain[meta.key] ?? 0;
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
      }, 2200);
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
        onToggleFeed={() => setFeedOpen((v) => !v)}
      />
      <LiveChart buckets={buckets} pops={pops} onToggleFeed={() => setFeedOpen((v) => !v)} feedOpen={feedOpen} />
      {feedOpen && <LiveFeed recent={recent} />}
    </>
  );
}

/* ─────────────── status bar ─────────────── */

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
          className={`relative h-2 w-2 rounded-full ${connected ? "bg-good" : "bg-ink-faint"}`}
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

/* ─────────────── stats band ─────────────── */

function StatsBand({
  stats,
  sessionSwaps,
  sessionVol,
  feedOpen,
  onToggleFeed,
}: {
  stats: GlobalView | null;
  sessionSwaps: number;
  sessionVol: number;
  feedOpen: boolean;
  onToggleFeed: () => void;
}) {
  return (
    <div className="card grid grid-cols-2 sm:grid-cols-4 gap-px bg-rule overflow-hidden">
      <Tile label="Vol 24h" value={fmtMoney(stats?.vol24h)} sub="All chains · DEX trades" />
      <Tile
        label="Txs 24h"
        value={fmtCount(stats?.trades24h)}
        sub={
          stats
            ? `${fmtCount(stats.buys24h)} buys · ${fmtCount(stats.sells24h)} sells`
            : "All chains"
        }
      />
      <Tile label="Market Cap" value={fmtMoney(stats?.mcap)} sub="All tracked assets" />
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
  onClick,
  action,
}: {
  label: string;
  value: string;
  sub: string;
  emphasize?: boolean;
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
      className={`relative flex flex-col gap-3 px-5 py-6 bg-surface min-w-0 ${
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
    </div>
  );
}

/* ─────────────── time-series chart ─────────────── */

const CHART_W = 1100;
const CHART_H = 280;
const PAD_X = 40;
const PAD_Y = 20;

function LiveChart({
  buckets,
  pops,
  onToggleFeed,
  feedOpen,
}: {
  buckets: Bucket[];
  pops: ChartPop[];
  onToggleFeed: () => void;
  feedOpen: boolean;
}) {
  // Tick the "now" reference once per second so the right edge keeps advancing
  // even when no swaps arrive (visual continuity).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const { paths, yMax, latest, totalCum } = useMemo(
    () => computeChart(buckets, now),
    [buckets, now],
  );

  const empty = buckets.length === 0;

  return (
    <section className="card mt-4 relative overflow-hidden">
      <header className="flex items-center justify-between px-5 py-3 border-b border-rule">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Streamed volume · last 10 min
          </span>
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inset-0 rounded-full bg-good opacity-60 animate-ping" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-good" />
          </span>
          <span className="text-ink-faint">·</span>
          <span className="font-mono tabular text-[11px] text-ink-soft">
            {fmtMoney(totalCum)} total
          </span>
        </div>

        <button
          type="button"
          onClick={onToggleFeed}
          className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted hover:text-ink transition-colors"
        >
          {feedOpen ? "Hide feed ▾" : "View feed ▸"}
        </button>
      </header>

      {/* Legend strip — chain pills with colored dots */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 pt-3 pb-2 text-[11px]">
        {CHAIN_LIST.map((c) => {
          const last = buckets[buckets.length - 1];
          const v = last?.perChain[c.key] ?? 0;
          return (
            <span key={c.key} className="inline-flex items-center gap-2 text-ink-soft">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: c.color }}
                aria-hidden
              />
              <ProviderLogo slug={c.slug} name={c.display} size={14} />
              <span className="font-medium">{c.display}</span>
              <span className="font-mono tabular text-ink-faint">{fmtMoney(v)}</span>
            </span>
          );
        })}
      </div>

      {/* Chart area: SVG + pop overlay */}
      <div className="relative px-2 pb-4">
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          className="w-full h-[260px] sm:h-[280px]"
          aria-label="Live streamed volume per chain"
        >
          {/* Gridlines */}
          {[0.25, 0.5, 0.75].map((f) => {
            const y = PAD_Y + (CHART_H - PAD_Y * 2) * f;
            return (
              <line
                key={f}
                x1={PAD_X}
                x2={CHART_W - 8}
                y1={y}
                y2={y}
                stroke="var(--color-rule)"
                strokeDasharray="2 4"
                strokeWidth={1}
                opacity={0.5}
              />
            );
          })}

          {/* Per-chain soft-fill areas (visual weight even when one chain dominates) */}
          {paths.map((p) =>
            p.cumNow > 0 ? (
              <path
                key={`area-${p.chainKey}`}
                d={p.areaPath}
                fill={p.color}
                opacity={0.08}
              />
            ) : null,
          )}
          {/* Per-chain polylines */}
          {paths.map((p) => (
            <polyline
              key={p.chainKey}
              fill="none"
              stroke={p.color}
              strokeWidth={1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={p.points}
              opacity={p.cumNow > 0 ? 0.95 : 0.25}
            />
          ))}

          {/* Latest tip dots */}
          {latest.map((p) =>
            p.cum > 0 ? (
              <circle
                key={p.chainKey}
                cx={p.x}
                cy={p.y}
                r={3}
                fill={p.color}
                stroke="var(--color-surface)"
                strokeWidth={1.5}
              />
            ) : null,
          )}

          {/* Y-axis ticks (right side) */}
          {[1, 0.5].map((f) => {
            const y = PAD_Y + (CHART_H - PAD_Y * 2) * (1 - f);
            return (
              <text
                key={f}
                x={CHART_W - 6}
                y={y + 4}
                textAnchor="end"
                fontFamily="var(--font-mono)"
                fontSize={10}
                fill="var(--color-ink-faint)"
              >
                {fmtMoney(yMax * f)}
              </text>
            );
          })}

          {/* X-axis labels */}
          <text
            x={PAD_X}
            y={CHART_H - 4}
            textAnchor="start"
            fontFamily="var(--font-mono)"
            fontSize={10}
            fill="var(--color-ink-faint)"
          >
            10 min ago
          </text>
          <text
            x={CHART_W - 8}
            y={CHART_H - 4}
            textAnchor="end"
            fontFamily="var(--font-mono)"
            fontSize={10}
            fill="var(--color-ink-faint)"
          >
            now
          </text>

          {empty && (
            <text
              x={CHART_W / 2}
              y={CHART_H / 2}
              textAnchor="middle"
              fontFamily="var(--font-mono)"
              fontSize={12}
              fill="var(--color-ink-faint)"
            >
              Listening for swaps…
            </text>
          )}
        </svg>

        {/* Floating swap pops anchored to line tips */}
        <div className="pointer-events-none absolute inset-x-2 inset-y-0">
          {pops.map((p) => (
            <ChartPopBubble key={p.id} pop={p} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────── chart math ─────────────── */

type ChainLatest = { chainKey: string; color: string; x: number; y: number; cum: number };

type ChainPath = { chainKey: string; color: string; points: string; areaPath: string; cumNow: number };

function computeChart(buckets: Bucket[], nowMs: number): {
  paths: ChainPath[];
  yMax: number;
  latest: ChainLatest[];
  totalCum: number;
} {
  const xMin = nowMs - WINDOW_MS;
  const innerW = CHART_W - PAD_X - 8;
  const innerH = CHART_H - PAD_Y * 2;
  const baseY = PAD_Y + innerH;

  const xScale = (ts: number) => PAD_X + ((ts - xMin) / WINDOW_MS) * innerW;

  // Pre-compute cumulative-per-chain at every bucket boundary.
  const cum: Record<string, number> = {};
  const cumPerBucket: Array<{ x: number; ys: Record<string, number> }> = [];
  for (const chain of CHAIN_LIST) cum[chain.key] = 0;

  for (const b of buckets) {
    for (const chain of CHAIN_LIST) {
      cum[chain.key] += b.perChain[chain.key] ?? 0;
    }
    cumPerBucket.push({ x: xScale(b.ts), ys: { ...cum } });
  }

  let yMax = 0;
  for (const k in cum) if (cum[k] > yMax) yMax = cum[k];
  yMax = niceCeil(yMax || 1);

  const yScale = (v: number) => baseY - (v / yMax) * innerH;

  const paths: ChainPath[] = [];
  const latest: ChainLatest[] = [];
  let totalCum = 0;

  for (const chain of CHAIN_LIST) {
    let points = "";
    let areaPath = "";
    let lastX = 0;
    let lastY = baseY;
    const cumNow = cum[chain.key] ?? 0;
    totalCum += cumNow;

    if (cumPerBucket.length > 0) {
      const first = cumPerBucket[0];
      areaPath += `M ${first.x.toFixed(1)} ${baseY.toFixed(1)} `;
      for (const p of cumPerBucket) {
        const x = p.x;
        const y = yScale(p.ys[chain.key] ?? 0);
        points += `${x.toFixed(1)},${y.toFixed(1)} `;
        areaPath += `L ${x.toFixed(1)} ${y.toFixed(1)} `;
        lastX = x;
        lastY = y;
      }
      areaPath += `L ${lastX.toFixed(1)} ${baseY.toFixed(1)} Z`;
    }

    paths.push({
      chainKey: chain.key,
      color: chain.color,
      points: points.trim(),
      areaPath,
      cumNow,
    });
    if (cumPerBucket.length > 0) {
      latest.push({ chainKey: chain.key, color: chain.color, x: lastX, y: lastY, cum: cumNow });
    }
  }
  return { paths, yMax, latest, totalCum };
}

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const frac = v / mag;
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return niceFrac * mag;
}

/* ─────────────── floating pop bubble ─────────────── */

function ChartPopBubble({ pop }: { pop: ChartPop }) {
  const meta = chainMeta(pop.chainKey);
  if (!meta) return null;
  const isBuy = pop.side === "buy";
  const color = isBuy ? "var(--color-good)" : "var(--color-bad)";

  // Cap the right side so the bubble never overflows the chart edge.
  const left = `${Math.min(pop.anchorX, 96)}%`;
  const top = `${Math.max(0, Math.min(pop.anchorY, 85))}%`;

  return (
    <div
      className="absolute chart-pop-rise -translate-y-1/2"
      style={{
        left,
        top,
        // Anchor near the line tip; the translate above centers vertically on it.
      }}
      aria-hidden
    >
      <div
        className="inline-flex items-center gap-1.5 rounded-full pl-1 pr-2 py-0.5 bg-surface border whitespace-nowrap shadow-sm"
        style={{ borderColor: meta.color, color: "var(--color-ink)" }}
      >
        <ProviderLogo slug={meta.slug} name={meta.display} size={14} />
        <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-ink-soft">
          {pop.pair}
        </span>
        <span className="font-mono font-semibold tabular text-[11px]" style={{ color }}>
          {isBuy ? "+" : "+"}
          {fmtMoney(pop.usd)}
        </span>
      </div>
    </div>
  );
}

/* ─────────────── live feed (drill-down) ─────────────── */

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
          last {recent.length} swaps
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
                  Listening for swaps…
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
  const meta = chainMeta(s.chain) ?? { slug: (s.chain || "").toLowerCase(), display: s.chain || "—" };
  const isBuy = s.side === "buy";
  const sideColor = isBuy ? "text-good" : "text-bad";
  const sideArrow = isBuy ? "▲" : "▼";
  const isWhale = s.usd >= 100_000;
  const isBig = s.usd >= 10_000;
  const usdClass = isWhale
    ? "font-semibold text-warn"
    : isBig
      ? "font-semibold text-ink"
      : "text-ink";
  const lagClass = lag < 1000 ? "text-good" : lag < 3000 ? "text-warn" : "text-bad";

  return (
    <tr className={fresh ? "feed-fresh" : ""}>
      <td className="px-4 py-2 tabular text-[11px] text-ink-muted whitespace-nowrap">{time}</td>
      <td className="px-2 py-2">
        <span className="inline-flex items-center gap-2">
          <ProviderLogo slug={meta.slug} name={meta.display} size={16} />
          <span className="text-[11px] text-ink-soft hidden sm:inline">{meta.display}</span>
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

/* ─────────────── formatting ─────────────── */

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
