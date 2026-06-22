"use client";

import { useMemo, useRef, useState } from "react";
import type { PmVenueHistory } from "@/lib/pm-venue-data";

/**
 * 90d combo chart: daily volume bars (teal) + open-interest line (cyan)
 * on a second y-axis. Pure SVG, same chassis as `hl-performance-chart`
 * with a hover crosshair + floating tooltip.
 *
 * Pattern notes:
 *  - Two axes: left = volume USD, right = open interest USD. Both use
 *    `niceMax` so the gridlines land on round numbers.
 *  - Bars get a vertical gradient (lighter top → solid bottom). Looks
 *    correct on both light + dark mode because the gradient is anchored
 *    to opacity, not to a paper colour.
 *  - OI line uses an area fill below it so the chart stays readable even
 *    when bars are tall.
 *  - Hidden gracefully if the harness/cron hasn't backfilled enough days
 *    yet (`PmVenueSection` skips us when history is null).
 */

const VOL_COLOR = "#14b8a6";
const VOL_COLOR_TOP = "#5eead4";
const OI_COLOR = "#06b6d4";

export function PmVolumeOiChart({ history }: { history: PmVenueHistory }) {
  if (history.points.length < 7) return null;
  return <Canvas history={history} />;
}

function Canvas({ history }: { history: PmVenueHistory }) {
  const W = 1100;
  const H = 340;
  const PAD_L = 64;
  const PAD_R = 64;
  const PAD_T = 28;
  const PAD_B = 56;

  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const n = history.points.length;

  const maxVol = useMemo(
    () => Math.max(...history.points.map((p) => p.volume), 0),
    [history.points],
  );
  const maxOi = useMemo(
    () => Math.max(...history.points.map((p) => p.oi ?? 0), 0),
    [history.points],
  );
  const niceMaxVol = niceMax(maxVol);
  const niceMaxOi = niceMax(maxOi);

  const totalVol = useMemo(
    () => history.points.reduce((a, p) => a + p.volume, 0),
    [history.points],
  );
  const peakOi = useMemo(() => maxOi, [maxOi]);

  const barW = Math.max(4, plotW / n - 4);
  const xFor = (i: number) => PAD_L + (plotW * (i + 0.5)) / n;
  const yBar = (v: number) =>
    PAD_T + plotH - (niceMaxVol > 0 ? (v / niceMaxVol) * plotH : 0);
  const yLine = (v: number) =>
    PAD_T + plotH - (niceMaxOi > 0 ? (v / niceMaxOi) * plotH : 0);

  const ticks = [0, 0.25, 0.5, 0.75, 1.0];
  const xLabelEvery = Math.max(1, Math.ceil(n / 8));

  // Build the OI line only over points where oi is defined; skip nulls
  // by lifting the pen (M instead of L). Avoids drawing a fake straight
  // line through a backfilled gap.
  const linePath = useMemo(() => {
    let path = "";
    let penDown = false;
    history.points.forEach((p, i) => {
      if (p.oi == null) {
        penDown = false;
        return;
      }
      path += `${penDown ? "L" : "M"} ${xFor(i).toFixed(1)} ${yLine(p.oi).toFixed(1)} `;
      penDown = true;
    });
    return path.trim();
  }, [history.points, niceMaxOi]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasOi = history.points.some((p) => p.oi != null);

  // Area fill = line closed back to baseline. We only build it when the
  // entire window has oi defined; partial fills look misleading.
  const areaPath = useMemo(() => {
    if (!hasOi) return "";
    const allDefined = history.points.every((p) => p.oi != null);
    if (!allDefined) return "";
    const segs = history.points
      .map(
        (p, i) =>
          `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yLine(p.oi!).toFixed(1)}`,
      )
      .join(" ");
    return `${segs} L ${xFor(n - 1).toFixed(1)} ${(PAD_T + plotH).toFixed(1)} L ${xFor(0).toFixed(1)} ${(PAD_T + plotH).toFixed(1)} Z`;
  }, [history.points, hasOi, n, plotH]); // eslint-disable-line react-hooks/exhaustive-deps

  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const onMove: React.PointerEventHandler<SVGSVGElement> = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const px = xRatio * W;
    if (px < PAD_L || px > W - PAD_R) {
      setHover(null);
      return;
    }
    const i = Math.min(
      n - 1,
      Math.max(0, Math.floor(((px - PAD_L) / plotW) * n)),
    );
    setHover(i);
  };

  return (
    <div
      className="rounded-xl p-4 sm:p-6 border border-ink/10"
      style={{
        background:
          "linear-gradient(180deg, rgba(20,184,166,0.05), rgba(20,184,166,0.01) 60%, transparent)",
        boxShadow:
          "0 1px 0 rgba(0,0,0,0.02), 0 8px 24px -16px rgba(20,80,90,0.18)",
      }}
    >
      <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <div>
          <p
            className="label-mono text-[10px] text-ink-faint"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            Volume & open interest · last {history.days}d
          </p>
          <p className="text-sm text-ink-faint mt-0.5">
            Daily traded volume (bars) and outstanding OI (line)
          </p>
        </div>
        <div className="flex items-center gap-4 text-[11px]">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block w-3 h-3 rounded-[3px]"
              style={{
                background: `linear-gradient(180deg, ${VOL_COLOR_TOP}, ${VOL_COLOR})`,
              }}
            />
            <span className="font-medium text-ink">Volume</span>
          </span>
          {hasOi && (
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-3 rounded-full border border-paper"
                style={{
                  background: OI_COLOR,
                  boxShadow: `0 0 0 1.5px ${OI_COLOR}33`,
                }}
              />
              <span className="font-medium text-ink">Open Interest</span>
            </span>
          )}
        </div>
      </div>

      <div className="relative w-full overflow-hidden">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-[300px] sm:h-[340px] block"
          preserveAspectRatio="none"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id="pm-vol-grad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={VOL_COLOR_TOP} stopOpacity={0.95} />
              <stop offset="100%" stopColor={VOL_COLOR} stopOpacity={0.85} />
            </linearGradient>
            <linearGradient id="pm-vol-grad-hover" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#a7f3d0" stopOpacity={1} />
              <stop offset="100%" stopColor={VOL_COLOR} stopOpacity={1} />
            </linearGradient>
            <linearGradient id="pm-oi-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={OI_COLOR} stopOpacity={0.22} />
              <stop offset="100%" stopColor={OI_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>

          {ticks.map((t) => {
            const y = PAD_T + plotH * (1 - t);
            return (
              <g key={t}>
                <line
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  className="text-ink/8"
                  strokeWidth={1}
                  strokeDasharray={t === 0 ? "0" : "2 4"}
                />
                <text
                  x={PAD_L - 8}
                  y={y + 3}
                  textAnchor="end"
                  style={{ fontFamily: "var(--font-mono, monospace)" }}
                  className="fill-ink-faint text-[10px] tabular-nums"
                >
                  {fmtUSDShort(niceMaxVol * t)}
                </text>
                {hasOi && (
                  <text
                    x={W - PAD_R + 8}
                    y={y + 3}
                    textAnchor="start"
                    style={{ fontFamily: "var(--font-mono, monospace)" }}
                    className="fill-ink-faint text-[10px] tabular-nums"
                  >
                    {fmtUSDShort(niceMaxOi * t)}
                  </text>
                )}
              </g>
            );
          })}

          {areaPath && <path d={areaPath} fill="url(#pm-oi-area)" />}

          {history.points.map((p, i) => {
            const x = xFor(i) - barW / 2;
            const y = yBar(p.volume);
            const h = PAD_T + plotH - y;
            const isHovered = hover === i;
            return (
              <rect
                key={p.date}
                x={x}
                y={y}
                width={barW}
                height={Math.max(1, h)}
                rx={Math.min(3, barW / 2)}
                ry={Math.min(3, barW / 2)}
                fill={isHovered ? "url(#pm-vol-grad-hover)" : "url(#pm-vol-grad)"}
                opacity={hover === null ? 1 : isHovered ? 1 : 0.55}
                style={{ transition: "opacity 120ms ease-out" }}
              />
            );
          })}

          {linePath && (
            <path
              d={linePath}
              fill="none"
              stroke={OI_COLOR}
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {history.points.map((p, i) =>
            p.oi != null ? (
              <g key={p.date}>
                <circle
                  cx={xFor(i)}
                  cy={yLine(p.oi)}
                  r={hover === i ? 5 : 2.8}
                  fill="var(--color-paper, #fff)"
                  opacity={hover === null || hover === i ? 1 : 0.7}
                />
                <circle
                  cx={xFor(i)}
                  cy={yLine(p.oi)}
                  r={hover === i ? 3.2 : 1.8}
                  fill={OI_COLOR}
                />
              </g>
            ) : null,
          )}

          {hover !== null && (
            <line
              x1={xFor(hover)}
              x2={xFor(hover)}
              y1={PAD_T}
              y2={PAD_T + plotH}
              stroke="currentColor"
              className="text-ink/25"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
          )}

          {history.points.map((p, i) =>
            i % xLabelEvery === 0 || i === n - 1 ? (
              <text
                key={p.date}
                x={xFor(i)}
                y={H - PAD_B + 18}
                textAnchor="middle"
                style={{ fontFamily: "var(--font-mono, monospace)" }}
                className="fill-ink-faint text-[10px] tabular-nums"
                transform={`rotate(-12 ${xFor(i)} ${H - PAD_B + 18})`}
              >
                {fmtShortDate(p.date)}
              </text>
            ) : null,
          )}
        </svg>

        {hover !== null && (
          <Tooltip
            point={history.points[hover]}
            xFrac={xFor(hover) / W}
            yFrac={
              Math.min(
                yBar(history.points[hover].volume),
                history.points[hover].oi != null
                  ? yLine(history.points[hover].oi!)
                  : PAD_T + plotH,
              ) / H
            }
          />
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px]">
        <Stat
          label={`Volume ${history.days}d`}
          value={fmtUSD(totalVol)}
          accent={VOL_COLOR}
        />
        <Stat
          label="Peak OI"
          value={fmtUSD(peakOi)}
          accent={OI_COLOR}
        />
        <Stat
          label="Days observed"
          value={`${history.points.length}`}
        />
        <Stat
          label="As of"
          value={fmtAsOf(history.points[history.points.length - 1].date)}
          mono
        />
      </div>
    </div>
  );
}

function Tooltip({
  point,
  xFrac,
  yFrac,
}: {
  point: { date: number; volume: number; oi: number | null };
  xFrac: number;
  yFrac: number;
}) {
  const left = Math.max(4, Math.min(96, xFrac * 100));
  const top = Math.max(6, yFrac * 100 - 6);
  const flipX = left > 70;
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-lg border border-ink/15 bg-paper shadow-lg px-3 py-2 text-[11.5px]"
      style={{
        left: `${left}%`,
        top: `${top}%`,
        transform: `translate(${flipX ? "-100%" : "0%"}, -100%) translateX(${flipX ? -8 : 8}px) translateY(-6px)`,
        minWidth: 168,
      }}
    >
      <div className="flex items-center justify-between gap-3 mb-1">
        <span
          className="label-mono text-[10px] text-ink-faint"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {fmtFullDate(point.date)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3 leading-tight">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm"
            style={{
              background: `linear-gradient(180deg, ${VOL_COLOR_TOP}, ${VOL_COLOR})`,
            }}
          />
          <span className="text-ink-faint">Volume</span>
        </span>
        <span className="font-semibold tabular-nums">
          {fmtUSD(point.volume)}
        </span>
      </div>
      {point.oi != null && (
        <div className="flex items-center justify-between gap-3 leading-tight mt-0.5">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{ background: OI_COLOR }}
            />
            <span className="text-ink-faint">Open Interest</span>
          </span>
          <span className="font-semibold tabular-nums">
            {fmtUSD(point.oi)}
          </span>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  mono,
}: {
  label: string;
  value: string;
  accent?: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border border-ink/8 bg-paper/60 px-3 py-2">
      <p
        className="label-mono text-[9.5px] text-ink-faint uppercase tracking-wide flex items-center gap-1.5"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {accent && (
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: accent }}
          />
        )}
        {label}
      </p>
      <p
        className="mt-0.5 text-sm font-semibold tabular-nums"
        style={mono ? { fontFamily: "var(--font-mono, monospace)" } : undefined}
      >
        {value}
      </p>
    </div>
  );
}

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

function fmtShortDate(unix: number): string {
  const d = new Date(unix * 1000);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}`;
}

function fmtFullDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function fmtAsOf(unix: number): string {
  return new Date(unix * 1000).toUTCString().slice(5, 16) + " UTC";
}
