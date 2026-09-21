"use client";

import { useMemo, useState } from "react";
import type { WeeklyRatioPoint } from "@/lib/perp-volume-history";

/**
 * A ÷ B weekly volume ratio, in percent: one point per seven-day window
 * ending on the last closed day, dashed median of the weeks shown, the
 * latest window shaded. Pure SVG with a hover crosshair and a tooltip
 * that decomposes the ratio (A volume, B volume, distance to median).
 */
export function PerpVolumeRatioChart({
  points,
  medianPct,
  aName,
  bName,
  color,
}: {
  points: WeeklyRatioPoint[];
  medianPct: number | null;
  aName: string;
  bName: string;
  color: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const W = 1100;
  const H = 300;
  const PAD_L = 52;
  const PAD_R = 16;
  const PAD_T = 18;
  const PAD_B = 34;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const n = points.length;

  const maxRatio = useMemo(() => {
    const vals = points.map((p) => p.ratioPct ?? 0);
    return Math.max(50, ...vals, medianPct ?? 0);
  }, [points, medianPct]);
  const top = niceTop(maxRatio * 1.1);
  const x = (i: number) => PAD_L + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD_T + plotH - (v / top) * plotH;
  const ticks = niceTicks(top);

  const segments = useMemo(() => {
    const segs: string[] = [];
    let cur: string[] = [];
    points.forEach((p, i) => {
      if (p.ratioPct === null) {
        if (cur.length) segs.push(cur.join(" "));
        cur = [];
        return;
      }
      cur.push(`${x(i).toFixed(1)},${y(p.ratioPct).toFixed(1)}`);
    });
    if (cur.length) segs.push(cur.join(" "));
    return segs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, top, n]);

  const lastIdx = n - 1;
  const last = points[lastIdx];
  const hovered = hover !== null ? points[hover] : null;
  const shown = hovered ?? last;
  const slotW = n > 1 ? plotW / (n - 1) : plotW;

  return (
    <div className="w-full">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium tabular-nums text-ink">
          {last?.ratioPct !== null && last?.ratioPct !== undefined ? `${last.ratioPct.toFixed(1)}%` : "n/a"}
          <span className="font-normal text-ink-muted"> · week to {fmtDate(last?.end ?? "")}</span>
          {medianPct !== null && (
            <span className="font-normal text-ink-muted"> · median {medianPct.toFixed(1)}%</span>
          )}
        </p>
        <p className="text-[11px] text-ink-faint">
          {aName} ÷ {bName}, seven-day windows ending on the last closed day
        </p>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label={`${aName} volume divided by ${bName} volume, week by week`}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y(t)}
                y2={y(t)}
                stroke="currentColor"
                strokeOpacity={t === 0 ? 0.35 : 0.08}
              />
              <text
                x={PAD_L - 8}
                y={y(t) + 3}
                textAnchor="end"
                fontSize={10}
                fill="currentColor"
                fillOpacity={0.55}
                style={{ fontFamily: "var(--font-mono, monospace)" }}
              >
                {t}%
              </text>
            </g>
          ))}
          {/* 100% parity line when inside the range */}
          {top > 100 && (
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={y(100)}
              y2={y(100)}
              stroke="currentColor"
              strokeOpacity={0.25}
            />
          )}
          {/* latest window shaded */}
          {n > 1 && last && (
            <rect
              x={x(lastIdx) - slotW / 2}
              y={PAD_T}
              width={slotW / 2 + 4}
              height={plotH}
              fill={color}
              fillOpacity={0.08}
            />
          )}
          {medianPct !== null && (
            <g>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y(medianPct)}
                y2={y(medianPct)}
                stroke="currentColor"
                strokeOpacity={0.45}
                strokeDasharray="5 4"
              />
              <text
                x={W - PAD_R - 4}
                y={y(medianPct) - 5}
                textAnchor="end"
                fontSize={10}
                fill="currentColor"
                fillOpacity={0.6}
              >
                median {medianPct.toFixed(0)}%
              </text>
            </g>
          )}
          {segments.map((d, i) => (
            <polyline
              key={i}
              points={d}
              fill="none"
              stroke={color}
              strokeWidth={2.2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {points.map((p, i) =>
            p.ratioPct === null ? null : (
              <circle
                key={p.end}
                cx={x(i)}
                cy={y(p.ratioPct)}
                r={hover === i || i === lastIdx ? 4 : 2.2}
                fill={color}
                stroke="var(--color-paper)"
                strokeWidth={hover === i || i === lastIdx ? 1.5 : 0}
              />
            ),
          )}
          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD_T}
              y2={PAD_T + plotH}
              stroke="currentColor"
              strokeOpacity={0.35}
            />
          )}
          {points.map((p, i) => (
            <rect
              key={`h-${p.end}`}
              x={x(i) - slotW / 2}
              y={PAD_T}
              width={slotW}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
          {points.map((p, i) =>
            i % Math.max(1, Math.round(n / 7)) === 0 || i === lastIdx ? (
              <text
                key={`x-${p.end}`}
                x={x(i)}
                y={H - 10}
                textAnchor={i === 0 ? "start" : i === lastIdx ? "end" : "middle"}
                fontSize={10}
                fill="currentColor"
                fillOpacity={0.55}
                style={{ fontFamily: "var(--font-mono, monospace)" }}
              >
                {fmtDate(p.end)}
              </text>
            ) : null,
          )}
        </svg>
        {shown && (
          <div
            className="pointer-events-none absolute top-2 rounded border border-rule bg-paper px-3 py-2 text-[11px] shadow-sm"
            style={{
              left: `${Math.min(78, Math.max(2, ((x(hover ?? lastIdx) + 12) / W) * 100))}%`,
            }}
          >
            <p className="text-ink-muted">
              {fmtDate(shown.start)} to {fmtDate(shown.end)}
            </p>
            <table className="mt-1 tabular-nums">
              <tbody>
                <Row label={`${aName} ÷ ${bName}`} value={shown.ratioPct !== null ? `${shown.ratioPct.toFixed(1)}%` : "n/a"} strong color={color} />
                {medianPct !== null && shown.ratioPct !== null && (
                  <Row label="vs median" value={fmtPt(shown.ratioPct - medianPct)} />
                )}
                <Row label={`= ${aName} volume`} value={fmtUsd(shown.a)} />
                <Row label={`÷ ${bName} volume`} value={fmtUsd(shown.b)} />
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, strong, color }: { label: string; value: string; strong?: boolean; color?: string }) {
  return (
    <tr>
      <td className="pr-4 text-ink-muted">
        {color && <i className="mr-1.5 inline-block h-0.5 w-3 align-middle" style={{ background: color }} />}
        {label}
      </td>
      <td className={`text-right ${strong ? "font-semibold text-ink" : "text-ink"}`}>{value}</td>
    </tr>
  );
}

function niceTop(v: number): number {
  const steps = [50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000];
  for (const s of steps) if (v <= s) return s;
  return Math.ceil(v / 1000) * 1000;
}

function niceTicks(top: number): number[] {
  const step = top <= 150 ? 50 : top <= 300 ? 50 : top <= 500 ? 100 : top <= 1000 ? 250 : top / 4;
  const out: number[] = [];
  for (let t = 0; t <= top + 1e-9; t += step) out.push(Math.round(t));
  return out;
}

function fmtPt(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}pt`;
}

function fmtUsd(v: number | null): string {
  if (v === null) return "n/a";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtDate(iso: string): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]}`;
}
