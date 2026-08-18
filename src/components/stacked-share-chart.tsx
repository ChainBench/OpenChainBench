"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

type SeriesProvider = {
  slug: string;
  name: string;
  color: string;
  values: (number | null)[];
};

type SeriesResponse = {
  slug: string;
  timestamps: number[];
  providers: SeriesProvider[];
};

type BarRange = "30d" | "90d" | "1y";

// ── Helpers ────────────────────────────────────────────────────────────────

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  if (f <= 1) return exp;
  if (f <= 2) return 2 * exp;
  if (f <= 5) return 5 * exp;
  return 10 * exp;
}

function fmtUSDShort(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtUSD(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

function fmtShortDate(ms: number): string {
  const d = new Date(ms);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mmNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${mmNames[d.getUTCMonth()]} ${dd}`;
}

function fmtFullDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ── Stack computation ──────────────────────────────────────────────────────

type BarSeg = { slug: string; color: string; name: string; val: number; bottom: number; top: number };

function buildStacks(providers: SeriesProvider[], n: number) {
  let maxTotal = 0;
  const stacks: BarSeg[][] = [];
  for (let i = 0; i < n; i++) {
    let cumSum = 0;
    const total = providers.reduce((s, p) => s + (p.values[i] ?? 0), 0);
    if (total > maxTotal) maxTotal = total;
    const bar = providers.map((p) => {
      const val = p.values[i] ?? 0;
      const bottom = cumSum;
      cumSum += val;
      return { slug: p.slug, color: p.color, name: p.name, val, bottom, top: cumSum };
    });
    stacks.push(bar);
  }
  return { stacks, maxTotal };
}

// ── Main export ────────────────────────────────────────────────────────────

export function StackedShareChart({ slug }: { slug: string }) {
  const [data90d, setData90d] = useState<SeriesResponse | null>(null);
  const [data1y, setData1y] = useState<SeriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<BarRange>("90d");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    fetch(`/api/series/${encodeURIComponent(slug)}?range=90d&raw=1`)
      .then((r) => r.json())
      .then((d: SeriesResponse) => { setData90d(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [slug]);

  const handleRangeClick = (r: BarRange) => {
    if (r !== "1y") { setRange(r); return; }
    if (data1y) { setRange("1y"); return; }
    fetch(`/api/series/${encodeURIComponent(slug)}?range=1y&raw=1`)
      .then((r) => r.json())
      .then((d: SeriesResponse) => { setData1y(d); setRange("1y"); });
  };

  const rawData = range === "1y" ? data1y : data90d;

  const displayData = useMemo((): SeriesResponse | null => {
    if (!rawData) return null;
    if (range !== "30d") return rawData;
    const n = rawData.timestamps.length;
    const start = Math.max(0, n - 30);
    return {
      ...rawData,
      timestamps: rawData.timestamps.slice(start),
      providers: rawData.providers.map((p) => ({ ...p, values: p.values.slice(start) })),
    };
  }, [rawData, range]);

  const sorted = useMemo(() => {
    if (!displayData) return [];
    return [...displayData.providers].sort((a, b) => {
      const sumA = a.values.reduce<number>((s, v) => s + (v ?? 0), 0);
      const sumB = b.values.reduce<number>((s, v) => s + (v ?? 0), 0);
      return sumB - sumA;
    });
  }, [displayData]);

  const toggleExclude = (s: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });

  if (loading) return <LoadingSkeleton />;

  const noData = !displayData || displayData.providers.length === 0;
  const visibleSorted = sorted.filter((p) => !excluded.has(p.slug));

  const RANGES: BarRange[] = ["30d", "90d", "1y"];
  const RANGE_LABEL: Record<BarRange, string> = { "30d": "30d", "90d": "90d", "1y": "1y" };

  return (
    <div
      className="rounded-xl border border-ink/10 p-4 sm:p-6 mt-6"
      style={{
        background: "linear-gradient(180deg, rgba(99,102,241,0.04), rgba(99,102,241,0.01) 60%, transparent)",
      }}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <p
          className="text-[10px] uppercase tracking-widest text-ink-faint font-medium"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          Volume share · historical
        </p>
        {!noData && (
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => handleRangeClick(r)}
                className={
                  "px-2.5 py-1 rounded text-[11px] font-medium transition-colors " +
                  (range === r
                    ? "bg-ink/10 text-ink"
                    : "text-ink-faint hover:text-ink hover:bg-ink/5")
                }
              >
                {RANGE_LABEL[r]}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Empty state */}
      {noData && (
        <div className="flex flex-col items-center justify-center h-[180px] gap-2 text-ink-faint">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-40">
            <path d="M3 3v18h18" /><path d="M7 16l4-4 4 4 4-6" />
          </svg>
          <p className="text-sm">Gathering historical data</p>
          <p className="text-[11px] opacity-60">Check back in a few hours</p>
        </div>
      )}

      {/* Dual charts */}
      {!noData && displayData && visibleSorted.length > 0 && (
        <DualChart
          timestamps={displayData.timestamps}
          providers={visibleSorted}
          hoverIdx={hoverIdx}
          onHover={setHoverIdx}
        />
      )}

      {/* Legend */}
      {!noData && (
        <div className="flex flex-wrap gap-x-5 gap-y-2 mt-4">
          {sorted.map((p) => {
            const hidden = excluded.has(p.slug);
            return (
              <button
                key={p.slug}
                type="button"
                onClick={() => toggleExclude(p.slug)}
                className={
                  "flex items-center gap-1.5 text-[11px] transition-opacity " +
                  (hidden ? "opacity-30" : "opacity-100 hover:opacity-70")
                }
              >
                <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: p.color }} />
                <span className="font-medium text-ink">{p.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Dual chart: absolute on top, % share on bottom ─────────────────────────

function DualChart({
  timestamps,
  providers,
  hoverIdx,
  onHover,
}: {
  timestamps: number[];
  providers: SeriesProvider[];
  hoverIdx: number | null;
  onHover: (i: number | null) => void;
}) {
  const n = timestamps.length;
  const { stacks, maxTotal } = useMemo(() => buildStacks(providers, n), [providers, n]);
  const niceMaxTotal = niceMax(maxTotal);

  const W = 1100;
  const H_ABS = 220;
  const H_PCT = 200;
  const PAD_L = 58;
  const PAD_R = 12;
  const PAD_T = 8;
  const PAD_B_ABS = 8;
  const PAD_B_PCT = 40;

  const plotW = W - PAD_L - PAD_R;
  const plotH_abs = H_ABS - PAD_T - PAD_B_ABS;
  const plotH_pct = H_PCT - PAD_T - PAD_B_PCT;

  const barW = Math.max(2, plotW / n - (n > 60 ? 0.5 : 1));
  const xFor = (i: number) => PAD_L + (plotW * (i + 0.5)) / n;
  const yAbs = (v: number) => PAD_T + plotH_abs - (niceMaxTotal > 0 ? (v / niceMaxTotal) * plotH_abs : 0);
  const yPct = (frac: number) => PAD_T + plotH_pct - frac * plotH_pct;

  const gridTicks = [0, 0.25, 0.5, 0.75, 1];
  const xLabelEvery = n <= 30 ? 7 : n <= 90 ? 14 : 30;

  const svgAbsRef = useRef<SVGSVGElement>(null);
  const svgPctRef = useRef<SVGSVGElement>(null);

  const handlePointerMove = (svgRef: React.RefObject<SVGSVGElement | null>) =>
    (e: React.PointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const xRatio = (e.clientX - rect.left) / rect.width;
      const px = xRatio * W;
      if (px < PAD_L || px > W - PAD_R) { onHover(null); return; }
      const i = Math.min(n - 1, Math.max(0, Math.floor(((px - PAD_L) / plotW) * n)));
      onHover(i);
    };

  const renderBars = (mode: "abs" | "pct", plotH: number) =>
    stacks.map((bar, i) => {
      const total = bar.reduce((s, seg) => s + seg.val, 0);
      const x = xFor(i) - barW / 2;
      const isHovered = hoverIdx === i;
      return (
        <g key={i} opacity={hoverIdx === null ? 1 : isHovered ? 1 : 0.55}
          style={{ transition: "opacity 60ms ease-out" }}>
          {bar.map((seg) => {
            let y: number, h: number;
            if (mode === "abs") {
              y = yAbs(seg.top);
              h = niceMaxTotal > 0 ? (seg.val / niceMaxTotal) * plotH : 0;
            } else {
              const frac = total > 0 ? seg.val / total : 0;
              const topFrac = total > 0 ? seg.top / total : 0;
              y = yPct(topFrac);
              h = frac * plotH;
            }
            if (h < 0.5) return null;
            return <rect key={seg.slug} x={x} y={y} width={barW} height={h} fill={seg.color} opacity={0.92} />;
          })}
        </g>
      );
    });

  const renderGrid = (mode: "abs" | "pct") =>
    gridTicks.map((t) => {
      const y = mode === "abs" ? yAbs(niceMaxTotal * t) : yPct(t);
      return (
        <g key={t}>
          <line
            x1={PAD_L} x2={W - PAD_R} y1={y} y2={y}
            stroke="currentColor" className="text-ink/8"
            strokeWidth={1} strokeDasharray={t === 0 ? "0" : "2 4"}
          />
          <text
            x={PAD_L - 6} y={y + 3.5}
            textAnchor="end"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
            className="fill-ink-faint"
            fontSize={9}
          >
            {mode === "abs" ? fmtUSDShort(niceMaxTotal * t) : `${Math.round(t * 100)}%`}
          </text>
        </g>
      );
    });

  // Tooltip data
  const tooltipBar = hoverIdx !== null ? stacks[hoverIdx] : null;
  const tooltipTs = hoverIdx !== null ? timestamps[hoverIdx] : null;
  const tooltipXFrac = hoverIdx !== null ? xFor(hoverIdx) / W : 0;

  return (
    <div className="space-y-0">
      {/* Sub-label: absolute */}
      <p
        className="text-[10px] text-ink-faint mb-1"
        style={{ fontFamily: "var(--font-mono, monospace)", paddingLeft: `${(PAD_L / W) * 100}%` }}
      >
        Daily 24h notional (USD)
      </p>

      {/* Absolute chart */}
      <div className="relative w-full overflow-hidden">
        <svg
          ref={svgAbsRef}
          viewBox={`0 0 ${W} ${H_ABS}`}
          className="w-full block"
          style={{ height: "clamp(140px, 22vw, 220px)" }}
          preserveAspectRatio="none"
          onPointerMove={handlePointerMove(svgAbsRef)}
          onPointerLeave={() => onHover(null)}
        >
          {renderGrid("abs")}
          {renderBars("abs", plotH_abs)}
          {hoverIdx !== null && (
            <line
              x1={xFor(hoverIdx)} x2={xFor(hoverIdx)}
              y1={PAD_T} y2={PAD_T + plotH_abs}
              stroke="currentColor" className="text-ink/25"
              strokeWidth={1} strokeDasharray="3 3"
            />
          )}
        </svg>

        {/* Shared tooltip anchored to abs chart */}
        {tooltipBar && tooltipTs !== null && (
          <SharedTooltip
            ts={tooltipTs}
            bar={tooltipBar}
            xFrac={tooltipXFrac}
          />
        )}
      </div>

      {/* Divider */}
      <div className="h-px bg-ink/8 mx-0 my-2" />

      {/* Sub-label: share */}
      <p
        className="text-[10px] text-ink-faint mb-1"
        style={{ fontFamily: "var(--font-mono, monospace)", paddingLeft: `${(PAD_L / W) * 100}%` }}
      >
        Market share (%)
      </p>

      {/* Percentage chart */}
      <div className="relative w-full overflow-hidden">
        <svg
          ref={svgPctRef}
          viewBox={`0 0 ${W} ${H_PCT}`}
          className="w-full block"
          style={{ height: "clamp(120px, 18vw, 200px)" }}
          preserveAspectRatio="none"
          onPointerMove={handlePointerMove(svgPctRef)}
          onPointerLeave={() => onHover(null)}
        >
          {renderGrid("pct")}
          {renderBars("pct", plotH_pct)}
          {hoverIdx !== null && (
            <line
              x1={xFor(hoverIdx)} x2={xFor(hoverIdx)}
              y1={PAD_T} y2={PAD_T + plotH_pct}
              stroke="currentColor" className="text-ink/25"
              strokeWidth={1} strokeDasharray="3 3"
            />
          )}
          {/* X-axis date labels only on bottom chart */}
          {timestamps.map((ts, i) => {
            if (i % xLabelEvery !== 0 && i !== n - 1) return null;
            return (
              <text
                key={i}
                x={xFor(i)} y={H_PCT - PAD_B_PCT + 14}
                textAnchor="middle"
                style={{ fontFamily: "var(--font-mono, monospace)" }}
                className="fill-ink-faint"
                fontSize={9}
              >
                {fmtShortDate(ts)}
              </text>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ── Shared tooltip ─────────────────────────────────────────────────────────

function SharedTooltip({
  ts,
  bar,
  xFrac,
}: {
  ts: number;
  bar: BarSeg[];
  xFrac: number;
}) {
  const total = bar.reduce((s, seg) => s + seg.val, 0);
  const flipX = xFrac > 0.6;
  const rows = [...bar].sort((a, b) => b.val - a.val).filter((s) => s.val > 0);

  return (
    <div
      className="pointer-events-none absolute z-20 rounded-lg border border-ink/15 bg-paper/95 backdrop-blur-sm shadow-xl px-3 py-2.5 text-[11px]"
      style={{
        left: `${Math.max(2, Math.min(94, xFrac * 100))}%`,
        top: "6%",
        transform: `translateX(${flipX ? "-100%" : "0%"}) translateX(${flipX ? -10 : 10}px)`,
        minWidth: 210,
        maxWidth: 240,
      }}
    >
      <p
        className="text-[10px] text-ink-faint mb-2 font-medium"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {fmtFullDate(ts)}
      </p>
      <div className="space-y-1.5">
        {rows.map((seg) => {
          const pct = total > 0 ? (seg.val / total) * 100 : 0;
          return (
            <div key={seg.slug} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: seg.color }} />
                <span className="text-ink-faint truncate">{seg.name}</span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <span className="text-ink/50 tabular-nums text-[10px]">{pct.toFixed(1)}%</span>
                <span className="font-semibold tabular-nums text-ink">{fmtUSD(seg.val)}</span>
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 pt-2 border-t border-ink/10 flex items-center justify-between">
        <span className="text-ink-faint">Total</span>
        <span className="font-semibold tabular-nums">{fmtUSD(total)}</span>
      </div>
    </div>
  );
}

// ── Loading skeleton ───────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="rounded-xl border border-ink/10 p-4 sm:p-6 mt-6 animate-pulse">
      <div className="h-3 w-36 bg-ink/8 rounded mb-5" />
      <div className="h-[220px] w-full bg-ink/5 rounded mb-2" />
      <div className="h-px bg-ink/8 my-2" />
      <div className="h-[180px] w-full bg-ink/5 rounded" />
    </div>
  );
}
