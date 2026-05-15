"use client";

import { useEffect, useMemo, useState } from "react";
import { LiveDot } from "@/components/live-dot";
import { ProviderLogo } from "@/components/provider-logo";
import { cumulativePerChain, niceCeil } from "@/lib/live/buckets";
import {
  CHART_H,
  CHART_PAD_X,
  CHART_PAD_Y,
  CHART_W,
  WINDOW_MS,
} from "@/lib/live/config";
import { CHAIN_LIST, chainMeta } from "@/lib/live/chains";
import { fmtMoney } from "@/lib/live/format";
import type { Bucket, ChartPop, SwapEvent } from "@/lib/live/types";
import { CompactFeed } from "./compact-feed";

type Props = {
  buckets: Bucket[];
  pops: ChartPop[];
  recent: SwapEvent[];
  serverOffsetMs: number;
  hiddenChains: Set<string>;
  onToggleChain: (key: string) => void;
};

export function LiveChart({
  buckets,
  pops,
  recent,
  serverOffsetMs,
  hiddenChains,
  onToggleChain,
}: Props) {
  // Tick once per second so the chart's right edge keeps advancing even
  // during quiet periods. Apply the server offset so bucket timestamps
  // from the relay line up with the chart's xMax.
  const [clientNow, setClientNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClientNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const serverNow = clientNow + serverOffsetMs;

  // Shared cumulative pass used by both chart computation and legend totals.
  const cumPerChain = useMemo(() => cumulativePerChain(buckets), [buckets]);

  const { paths, yMax, latest, totalCum } = useMemo(
    () => computeChart(buckets, serverNow, hiddenChains, cumPerChain),
    [buckets, serverNow, hiddenChains, cumPerChain],
  );

  const empty = buckets.length === 0;

  return (
    <section className="card mt-4 relative overflow-hidden">
      <header className="flex items-center gap-3 px-5 py-3 border-b border-rule">
        <span className="label-mono text-ink-muted">Streamed volume · last 10 min</span>
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
          />
        </div>

        <aside className="border-t lg:border-t-0 lg:border-l border-rule flex flex-col">
          <CompactFeed recent={recent} hiddenChains={hiddenChains} />
        </aside>
      </div>
    </section>
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
}: {
  paths: ChainPath[];
  latest: ChainLatest[];
  yMax: number;
  hiddenChains: Set<string>;
  pops: ChartPop[];
  empty: boolean;
}) {
  return (
    <div className="relative px-2 pb-4">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="none"
        className="w-full h-[280px]"
        aria-label="Live streamed volume per chain"
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
              opacity={0.08}
            />
          ) : null,
        )}
        {paths.map((p) =>
          hiddenChains.has(p.chainKey) ? null : (
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
          ),
        )}

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

      <div className="pointer-events-none absolute inset-x-2 inset-y-0">
        {pops
          .filter((p) => !hiddenChains.has(p.chainKey))
          .map((p) => (
            <ChartPopBubble key={p.id} pop={p} />
          ))}
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

function computeChart(
  buckets: Bucket[],
  nowMs: number,
  hiddenChains: Set<string>,
  cumNow: Record<string, number>,
): {
  paths: ChainPath[];
  yMax: number;
  latest: ChainLatest[];
  totalCum: number;
} {
  const xMin = nowMs - WINDOW_MS;
  const innerW = CHART_W - CHART_PAD_X - 8;
  const innerH = CHART_H - CHART_PAD_Y * 2;
  const baseY = CHART_PAD_Y + innerH;

  const xScale = (ts: number) => CHART_PAD_X + ((ts - xMin) / WINDOW_MS) * innerW;

  // Compute cumulative-per-bucket once.
  const running: Record<string, number> = {};
  for (const chain of CHAIN_LIST) running[chain.key] = 0;
  const cumPerBucket: Array<{ x: number; ys: Record<string, number> }> = [];
  for (const b of buckets) {
    for (const chain of CHAIN_LIST) {
      running[chain.key] += b.perChain[chain.key] ?? 0;
    }
    cumPerBucket.push({ x: xScale(b.ts), ys: { ...running } });
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
  return { paths, yMax, latest, totalCum };
}
