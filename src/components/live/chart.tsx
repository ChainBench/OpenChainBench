"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { LiveDot } from "@/components/live-dot";
import { ProviderLogo } from "@/components/provider-logo";
import { cumulativePerChain, niceCeil } from "@/lib/live/buckets";
import {
  CHART_H,
  CHART_PAD_X,
  CHART_PAD_Y,
  CHART_W,
  RANGE_LABELS,
} from "@/lib/live/config";
import { CHAIN_LIST, chainMeta } from "@/lib/live/chains";
import { fmtMoney } from "@/lib/live/format";
import type {
  Bucket,
  ChartPop,
  ChartSeries,
  RangeKey,
  SwapEvent,
} from "@/lib/live/types";
import { CompactFeed } from "./compact-feed";

const RANGE_ORDER: RangeKey[] = ["10m", "1h", "24h"];

function fmtSpan(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return `${h} h ago`;
}

type Props = {
  series: ChartSeries;
  range: RangeKey;
  onRangeChange: (r: RangeKey) => void;
  pops: ChartPop[];
  recent: SwapEvent[];
  serverOffsetMs: number;
  hiddenChains: Set<string>;
  onToggleChain: (key: string) => void;
};

export function LiveChart({
  series,
  range,
  onRangeChange,
  pops,
  recent,
  serverOffsetMs,
  hiddenChains,
  onToggleChain,
}: Props) {
  const [clientNow, setClientNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClientNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const serverNow = clientNow + serverOffsetMs;

  const cumPerChain = useMemo(
    () => cumulativePerChain(series.buckets),
    [series.buckets],
  );

  const { paths, yMax, latest, totalCum, effectiveWindowMs, hoverPoints, yScale } = useMemo(
    () => computeChart(series.buckets, serverNow, hiddenChains, cumPerChain, series.windowMs),
    [series.buckets, series.windowMs, serverNow, hiddenChains, cumPerChain],
  );

  const empty = series.buckets.length === 0;
  const leftLabel = fmtSpan(effectiveWindowMs);

  return (
    <section className="card mt-4 relative overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-rule">
        <span className="label-mono text-ink-muted">Streamed volume</span>
        <span className="text-ink-faint">·</span>
        <RangePicker range={range} onRangeChange={onRangeChange} />
        <LiveDot />
        <span className="text-ink-faint">·</span>
        <span className="font-mono tabular text-[11px] text-ink-soft">
          {fmtMoney(totalCum)} total
        </span>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <ChainLegend
            cumPerChain={cumPerChain}
            hiddenChains={hiddenChains}
            onToggleChain={onToggleChain}
          />
          <ChartCanvas
            paths={paths}
            latest={latest}
            yMax={yMax}
            hiddenChains={hiddenChains}
            pops={pops}
            empty={empty}
            leftLabel={leftLabel}
            hoverPoints={hoverPoints}
            yScale={yScale}
            nowMs={serverNow}
          />
        </div>

        <aside className="border-t lg:border-t-0 lg:border-l border-rule flex flex-col">
          <CompactFeed recent={recent} hiddenChains={hiddenChains} />
        </aside>
      </div>
    </section>
  );
}

/* ─────────────── inline range picker ─────────────── */

function RangePicker({
  range,
  onRangeChange,
}: {
  range: RangeKey;
  onRangeChange: (r: RangeKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="label-mono inline-flex items-center gap-1.5 text-ink hover:text-ink/70 transition-colors"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {RANGE_LABELS[range].toLowerCase()}
        <ChevronDown
          size={11}
          strokeWidth={2.2}
          className={`text-ink-faint transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute left-0 top-full z-20 mt-1.5 min-w-[10rem] rounded-sm bg-paper ring-1 ring-ink/[0.08] shadow-[0_10px_28px_-12px_rgba(20,17,12,0.35)] overflow-hidden"
        >
          {RANGE_ORDER.map((r) => {
            const active = r === range;
            return (
              <li key={r}>
                <button
                  type="button"
                  onClick={() => {
                    onRangeChange(r);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left label-mono transition-colors ${
                    active
                      ? "text-ink bg-ink/[0.04]"
                      : "text-ink-muted hover:text-ink hover:bg-ink/[0.03]"
                  }`}
                >
                  <span>{RANGE_LABELS[r].toLowerCase()}</span>
                  {active && (
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: "var(--color-good)" }}
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ─────────────── legend ─────────────── */

function ChainLegend({
  cumPerChain,
  hiddenChains,
  onToggleChain,
}: {
  cumPerChain: Record<string, number>;
  hiddenChains: Set<string>;
  onToggleChain: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-3 pb-2 text-[11px]">
      {CHAIN_LIST.map((c) => {
        const cum = cumPerChain[c.key] ?? 0;
        const hidden = hiddenChains.has(c.key);
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onToggleChain(c.key)}
            aria-pressed={!hidden}
            title={hidden ? `Show ${c.display}` : `Hide ${c.display}`}
            className={`inline-flex items-center gap-2 rounded-full px-2 py-0.5 transition-opacity ${
              hidden
                ? "opacity-40 hover:opacity-70 text-ink-faint line-through decoration-1"
                : "opacity-100 text-ink-soft hover:bg-paper-soft"
            }`}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: c.color }}
              aria-hidden
            />
            <ProviderLogo slug={c.slug} name={c.display} size={14} />
            <span className="font-medium">{c.display}</span>
            <span className="font-mono tabular text-ink-faint">{fmtMoney(cum)}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ─────────────── SVG canvas + pop overlay ─────────────── */

type ChainPath = {
  chainKey: string;
  color: string;
  points: string;
  areaPath: string;
  cumNow: number;
};
type ChainLatest = { chainKey: string; color: string; x: number; y: number; cum: number };

function ChartCanvas({
  paths,
  latest,
  yMax,
  hiddenChains,
  pops,
  empty,
  leftLabel,
  hoverPoints,
  yScale,
  nowMs,
}: {
  paths: ChainPath[];
  latest: ChainLatest[];
  yMax: number;
  hiddenChains: Set<string>;
  pops: ChartPop[];
  empty: boolean;
  leftLabel: string;
  hoverPoints: HoverPoint[];
  yScale: (v: number) => number;
  nowMs: number;
}) {
  type HoverState = {
    idx: number;
    xPx: number;
    yPx: number;
    svgY: number;
    containerW: number;
    containerH: number;
  };
  const [hover, setHover] = useState<HoverState | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    if (hoverPoints.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;
    const xRatio = xPx / rect.width;
    const svgX = xRatio * CHART_W;
    const svgY = (yPx / rect.height) * CHART_H;
    // Find closest bucket by X. Linear scan is fine, buckets are ~150 max.
    let bestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < hoverPoints.length; i++) {
      const d = Math.abs(hoverPoints[i].x - svgX);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    setHover({
      idx: bestIdx,
      xPx,
      yPx,
      svgY,
      containerW: rect.width,
      containerH: rect.height,
    });
  }

  const hoverPoint = hover != null ? hoverPoints[hover.idx] : null;

  // Closest chain to the cursor's Y at the hovered X. Used to bold its
  // line and emphasize its row in the tooltip.
  const closestChain: string | null = (() => {
    if (!hover || !hoverPoint) return null;
    let bestKey: string | null = null;
    let bestDist = 30; // SVG units. Only highlight when within ~30 of a line.
    for (const c of CHAIN_LIST) {
      if (hiddenChains.has(c.key)) continue;
      const v = hoverPoint.ys[c.key] ?? 0;
      if (v <= 0) continue;
      const lineY = yScale(v);
      const d = Math.abs(lineY - hover.svgY);
      if (d < bestDist) {
        bestDist = d;
        bestKey = c.key;
      }
    }
    return bestKey;
  })();

  return (
    <div className="relative px-2 pb-4">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="none"
        className="w-full h-[280px]"
        aria-label="Live streamed volume per chain"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {[0.25, 0.5, 0.75].map((f) => {
          const y = CHART_PAD_Y + (CHART_H - CHART_PAD_Y * 2) * f;
          return (
            <line
              key={f}
              x1={CHART_PAD_X}
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

        {paths.map((p) =>
          !hiddenChains.has(p.chainKey) && p.cumNow > 0 ? (
            <path
              key={`area-${p.chainKey}`}
              d={p.areaPath}
              fill={p.color}
              opacity={closestChain === p.chainKey ? 0.18 : 0.08}
            />
          ) : null,
        )}
        {paths.map((p) => {
          if (hiddenChains.has(p.chainKey)) return null;
          const focused = closestChain === p.chainKey;
          const dim = closestChain != null && !focused;
          return (
            <polyline
              key={p.chainKey}
              fill="none"
              stroke={p.color}
              strokeWidth={focused ? 2.6 : 1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={p.points}
              opacity={p.cumNow > 0 ? (dim ? 0.45 : 0.95) : 0.25}
            />
          );
        })}

        {latest.map((p) =>
          !hiddenChains.has(p.chainKey) && p.cum > 0 ? (
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

        {[1, 0.5].map((f) => {
          const y = CHART_PAD_Y + (CHART_H - CHART_PAD_Y * 2) * (1 - f);
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

        <text
          x={CHART_PAD_X}
          y={CHART_H - 4}
          textAnchor="start"
          fontFamily="var(--font-mono)"
          fontSize={10}
          fill="var(--color-ink-faint)"
        >
          {leftLabel}
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

        {/* Hover crosshair: vertical dotted line + per-chain dots */}
        {hoverPoint && (
          <g pointerEvents="none">
            <line
              x1={hoverPoint.x}
              x2={hoverPoint.x}
              y1={CHART_PAD_Y}
              y2={CHART_H - CHART_PAD_Y}
              stroke="var(--color-ink)"
              strokeOpacity={0.4}
              strokeDasharray="2 3"
              strokeWidth={1}
            />
            {CHAIN_LIST.map((c) => {
              if (hiddenChains.has(c.key)) return null;
              const v = hoverPoint.ys[c.key] ?? 0;
              if (v <= 0) return null;
              const focused = closestChain === c.key;
              return (
                <circle
                  key={`hov-${c.key}`}
                  cx={hoverPoint.x}
                  cy={yScale(v)}
                  r={focused ? 4 : 2.5}
                  fill={c.color}
                  stroke="var(--color-surface)"
                  strokeWidth={focused ? 2 : 1.25}
                />
              );
            })}
          </g>
        )}
      </svg>

      <div className="pointer-events-none absolute inset-x-2 inset-y-0">
        {pops
          .filter((p) => !hiddenChains.has(p.chainKey))
          .map((p) => (
            <ChartPopBubble key={p.id} pop={p} />
          ))}
      </div>

      {hover && hoverPoint && (
        <HoverTooltip
          point={hoverPoint}
          hiddenChains={hiddenChains}
          nowMs={nowMs}
          xPx={hover.xPx}
          yPx={hover.yPx}
          containerW={hover.containerW}
          containerH={hover.containerH}
          closestChain={closestChain}
        />
      )}
    </div>
  );
}

/* ─────────────── hover tooltip ─────────────── */

function fmtAgo(ms: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - ms);
  const totalSec = Math.floor(diff / 1000);
  if (totalSec < 60) return `${totalSec}s ago`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) {
    return sec > 0 ? `${totalMin}m ${sec}s ago` : `${totalMin}m ago`;
  }
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${h}h ${min}m ago` : `${h}h ago`;
}

// Approximate tooltip size used to clamp it inside the chart bounds.
const TIP_W = 200;
const TIP_H = 180;
const TIP_OFFSET = 14;

function HoverTooltip({
  point,
  hiddenChains,
  nowMs,
  xPx,
  yPx,
  containerW,
  containerH,
  closestChain,
}: {
  point: HoverPoint;
  hiddenChains: Set<string>;
  nowMs: number;
  xPx: number;
  yPx: number;
  containerW: number;
  containerH: number;
  closestChain: string | null;
}) {
  const visibleChains = CHAIN_LIST.filter(
    (c) => !hiddenChains.has(c.key) && (point.ys[c.key] ?? 0) > 0,
  ).sort((a, b) => (point.ys[b.key] ?? 0) - (point.ys[a.key] ?? 0));
  const total = visibleChains.reduce((s, c) => s + (point.ys[c.key] ?? 0), 0);

  // Flip the tooltip to the left of the cursor when it would overflow
  // the right edge. Clamp vertically.
  const flipX = xPx + TIP_OFFSET + TIP_W > containerW;
  const left = flipX ? xPx - TIP_OFFSET - TIP_W : xPx + TIP_OFFSET;
  const clampedLeft = Math.max(4, Math.min(left, containerW - TIP_W - 4));
  const top = Math.max(
    4,
    Math.min(yPx - TIP_H / 2, containerH - TIP_H - 4),
  );

  return (
    <div
      className="pointer-events-none absolute z-30"
      style={{ left: `${clampedLeft}px`, top: `${top}px` }}
    >
      <div
        className="min-w-[180px] rounded-sm bg-paper/95 backdrop-blur ring-1 ring-ink/10 shadow-[0_10px_24px_-12px_rgba(20,17,12,0.4)] px-3 py-2"
        style={{ width: TIP_W }}
      >
        <p className="label-mono text-ink-muted">
          {fmtAgo(point.ts, nowMs)}
        </p>
        <ul className="mt-2 space-y-1">
          {visibleChains.map((c) => {
            const focused = closestChain === c.key;
            return (
              <li
                key={c.key}
                className={`flex items-baseline justify-between gap-4 text-[11px] rounded-sm px-1 -mx-1 transition-colors ${
                  focused ? "bg-ink/[0.05]" : ""
                }`}
              >
                <span className="flex items-center gap-1.5 text-ink-soft">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: c.color }}
                  />
                  <span className={focused ? "font-semibold text-ink" : ""}>
                    {c.display}
                  </span>
                </span>
                <span
                  className={`font-mono tabular ${focused ? "font-semibold text-ink" : "text-ink"}`}
                >
                  {fmtMoney(point.ys[c.key] ?? 0)}
                </span>
              </li>
            );
          })}
        </ul>
        {visibleChains.length > 0 && (
          <div className="mt-2 pt-2 border-t border-rule flex items-baseline justify-between text-[11px]">
            <span className="label-mono text-ink-muted">Total</span>
            <span className="font-mono tabular font-semibold text-ink">
              {fmtMoney(total)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────── floating pop bubble ─────────────── */

function ChartPopBubble({ pop }: { pop: ChartPop }) {
  const meta = chainMeta(pop.chainKey);
  if (!meta) return null;
  const isBuy = pop.side === "buy";
  const color = isBuy ? "var(--color-good)" : "var(--color-bad)";

  const left = `${Math.min(pop.anchorX, 88)}%`;
  const top = `${Math.max(0, Math.min(pop.anchorY, 88))}%`;

  return (
    <div className="absolute chart-pop-rise -translate-y-1/2" style={{ left, top }} aria-hidden>
      <div
        className="inline-flex items-center gap-1 rounded-full pl-1 pr-1.5 py-0.5 bg-surface border whitespace-nowrap shadow-sm"
        style={{ borderColor: meta.color, color: "var(--color-ink)" }}
      >
        <ProviderLogo slug={meta.slug} name={meta.display} size={11} />
        <span className="font-mono text-[9px] uppercase tracking-[0.04em] text-ink-soft">
          {pop.pair}
        </span>
        <span className="font-mono font-semibold tabular text-[10px]" style={{ color }}>
          {isBuy ? "+" : "-"}
          {fmtMoney(pop.usd)}
        </span>
      </div>
    </div>
  );
}

/* ─────────────── chart math (pure) ─────────────── */

type HoverPoint = { x: number; ts: number; ys: Record<string, number> };

function computeChart(
  buckets: Bucket[],
  nowMs: number,
  hiddenChains: Set<string>,
  cumNow: Record<string, number>,
  windowMs: number,
): {
  paths: ChainPath[];
  yMax: number;
  latest: ChainLatest[];
  totalCum: number;
  effectiveWindowMs: number;
  hoverPoints: HoverPoint[];
  yScale: (v: number) => number;
} {
  // The relay always pads with empty buckets on the left so the array
  // spans the full nominal window. When the ring is still filling
  // (the 1h and 24h buckets right after a redeploy), those leading
  // buckets are zero. Find the first bucket with any data and tighten
  // the x-axis to that extent so the chart fills from the left instead
  // of squashing the action into the right edge.
  let firstDataTs = nowMs;
  for (const b of buckets) {
    let hasData = false;
    for (const k in b.perChain) {
      if ((b.perChain[k] ?? 0) > 0) {
        hasData = true;
        break;
      }
    }
    if (hasData) {
      firstDataTs = b.ts;
      break;
    }
  }
  const actualSpan = Math.max(60_000, nowMs - firstDataTs);
  // Always fit the x-axis to the data extent so the polyline starts
  // flush against the left edge of the chart. The label below the
  // chart reflects this actual span (e.g. "53 min ago") so the axis
  // and the reading stay consistent.
  const effectiveWindowMs = Math.min(windowMs, actualSpan);
  const xMin = nowMs - effectiveWindowMs;
  const innerW = CHART_W - CHART_PAD_X - 8;
  const innerH = CHART_H - CHART_PAD_Y * 2;
  const baseY = CHART_PAD_Y + innerH;

  const xScale = (ts: number) =>
    CHART_PAD_X + ((ts - xMin) / effectiveWindowMs) * innerW;

  const running: Record<string, number> = {};
  for (const chain of CHAIN_LIST) running[chain.key] = 0;
  const cumPerBucket: HoverPoint[] = [];
  let started = false;
  for (const b of buckets) {
    for (const chain of CHAIN_LIST) {
      running[chain.key] += b.perChain[chain.key] ?? 0;
    }
    // Drop the leading empty span so the polyline starts at the left
    // edge of the visible chart instead of running off-canvas.
    if (!started) {
      let any = false;
      for (const k in running) {
        if (running[k] > 0) {
          any = true;
          break;
        }
      }
      if (!any) continue;
      started = true;
    }
    cumPerBucket.push({ x: xScale(b.ts), ts: b.ts, ys: { ...running } });
  }

  let yMax = 0;
  for (const k in cumNow) {
    if (hiddenChains.has(k)) continue;
    if (cumNow[k] > yMax) yMax = cumNow[k];
  }
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
    const cumVal = cumNow[chain.key] ?? 0;
    if (!hiddenChains.has(chain.key)) totalCum += cumVal;

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
      cumNow: cumVal,
    });
    if (cumPerBucket.length > 0) {
      latest.push({
        chainKey: chain.key,
        color: chain.color,
        x: lastX,
        y: lastY,
        cum: cumVal,
      });
    }
  }
  return {
    paths,
    yMax,
    latest,
    totalCum,
    effectiveWindowMs,
    hoverPoints: cumPerBucket,
    yScale,
  };
}
