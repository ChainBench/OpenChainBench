"use client";

import { useMemo, useState } from "react";
import { ChartWatermarkHtml } from "@/components/chart-watermark";

/**
 * Daily cross-chain volume per trading app over 30 / 90 / 365 closed UTC
 * days: one line per app, hover crosshair with every app's figure for
 * that day. Pure SVG, no library. The parent decides which apps are in
 * (the hub passes the top ones by last-day volume, a product page passes
 * itself plus the leaders).
 */
export type TradingAppLine = {
  slug: string;
  name: string;
  color: string;
  values: (number | null)[];
};

export function TradingAppVolumeChart({
  days,
  lines,
  highlight,
  logScale = false,
}: {
  /** ISO days, oldest first, aligned with every line's values. */
  days: string[];
  lines: TradingAppLine[];
  /** Slug drawn on top with full opacity; others dimmed when set. */
  highlight?: string;
  logScale?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [span, setSpan] = useState<30 | 90 | 365>(90);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const shownDays = useMemo(() => days.slice(-span), [days, span]);
  const shown = useMemo(
    () => lines.map((l) => ({ ...l, values: l.values.slice(-span) })),
    [lines, span],
  );
  const visible = shown.filter((l) => !hidden.has(l.slug));
  const max = useMemo(
    () => Math.max(1, ...visible.flatMap((l) => l.values.map((v) => v ?? 0))),
    [visible],
  );
  const min = useMemo(() => {
    if (!logScale) return 0;
    const vals = visible.flatMap((l) => l.values.filter((v): v is number => v != null && v > 0));
    return vals.length ? Math.min(...vals) : 1;
  }, [visible, logScale]);
  const top = niceMax(max);
  const bottom = logScale ? Math.pow(10, Math.floor(Math.log10(Math.max(1, min)))) : 0;

  const W = 1100;
  const H = 320;
  const PAD_L = 56;
  const PAD_R = 12;
  const PAD_T = 16;
  const PAD_B = 30;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const n = shownDays.length;
  const x = (i: number) => PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v: number) => {
    if (logScale) {
      const lo = Math.log10(bottom);
      const hi = Math.log10(top);
      const t = (Math.log10(Math.max(v, bottom)) - lo) / Math.max(hi - lo, 1e-9);
      return PAD_T + plotH - t * plotH;
    }
    return PAD_T + plotH - (v / top) * plotH;
  };

  const ticks = logScale
    ? logTicks(bottom, top)
    : [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const hovered = hover !== null ? shownDays[hover] : null;

  const pathOf = (values: (number | null)[]) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v == null || (logScale && v <= 0)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d;
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD_L) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const toggle = (slug: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });

  return (
    <div className="relative w-full">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-soft">
          {shown.map((l) => (
            <button
              key={l.slug}
              type="button"
              onClick={() => toggle(l.slug)}
              className={`inline-flex items-center gap-1.5 ${hidden.has(l.slug) ? "opacity-40 line-through" : ""}`}
              title={hidden.has(l.slug) ? `Show ${l.name}` : `Hide ${l.name}`}
            >
              <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: l.color }} />
              {l.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <p className="text-[11px] text-ink-faint">
            {hovered ? fmtDate(hovered) : "UTC days, every chain summed"}
          </p>
          <div className="inline-flex overflow-hidden rounded border border-rule text-[11px]">
            {([30, 90, 365] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpan(s)}
                className={`px-2 py-0.5 ${span === s ? "bg-ink text-paper" : "text-ink-soft hover:text-ink"}`}
              >
                {s === 365 ? "1y" : `${s}d`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label="Daily trading app volume"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke="currentColor" strokeOpacity={0.08} />
            <text x={PAD_L - 6} y={y(t) + 3} fontSize={10} textAnchor="end" fill="currentColor" fillOpacity={0.5}>
              {fmtAxis(t)}
            </text>
          </g>
        ))}
        {visible.map((l) => {
          const dim = highlight && highlight !== l.slug;
          return (
            <path
              key={l.slug}
              d={pathOf(l.values)}
              fill="none"
              stroke={l.color}
              strokeWidth={highlight === l.slug ? 2.4 : 1.6}
              strokeOpacity={dim ? 0.35 : 0.95}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={PAD_T + plotH} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="3 3" />
            {visible.map((l) => {
              const v = l.values[hover];
              if (v == null) return null;
              return <circle key={l.slug} cx={x(hover)} cy={y(v)} r={3} fill={l.color} />;
            })}
          </g>
        )}
        <text x={PAD_L} y={H - 8} fontSize={10} fill="currentColor" fillOpacity={0.5}>
          {fmtDate(shownDays[0] ?? "")}
        </text>
        <text x={W - PAD_R} y={H - 8} fontSize={10} textAnchor="end" fill="currentColor" fillOpacity={0.5}>
          {fmtDate(shownDays.at(-1) ?? "")}
        </text>
      </svg>

      {hover !== null && (
        <div className="pointer-events-none absolute right-2 top-9 rounded-md border border-rule bg-paper px-3 py-2 shadow-xl text-[11px] tabular-nums">
          <p className="mb-1 text-ink-faint">{fmtDate(shownDays[hover])}</p>
          {[...visible]
            .map((l) => ({ l, v: l.values[hover] }))
            .sort((a, b) => (b.v ?? -1) - (a.v ?? -1))
            .map(({ l, v }) => (
              <p key={l.slug} className="flex items-center justify-between gap-4">
                <span className="inline-flex items-center gap-1.5 text-ink-soft">
                  <i className="inline-block h-2 w-2 rounded-sm" style={{ background: l.color }} />
                  {l.name}
                </span>
                <span className="text-ink">{fmtUsd(v)}</span>
              </p>
            ))}
        </div>
      )}
      <ChartWatermarkHtml />
    </div>
  );
}

function niceMax(v: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / exp;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return step * exp;
}

function logTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let p = Math.log10(lo); p <= Math.log10(hi) + 1e-9; p++) out.push(Math.pow(10, p));
  return out;
}

function fmtAxis(v: number): string {
  if (v === 0) return "0";
  if (v >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${+(v / 1e6).toFixed(0)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(0)}K`;
  return v.toFixed(0);
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
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}
