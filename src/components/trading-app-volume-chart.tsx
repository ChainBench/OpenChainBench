"use client";

import { useMemo, useState } from "react";
import { ChartWatermarkHtml } from "@/components/chart-watermark";

/**
 * Daily cross-chain volume per trading app over 30 / 90 / 365 closed UTC
 * days: one line per app, hover crosshair with every app's figure for
 * that day. Pure SVG, no library. The parent decides which apps are in
 * (the hub passes the top ones by last-day volume, a product page passes
 * itself plus the leaders).
 *
 * "Share" mode stacks the same apps as 100 % areas of the whole cohort
 * (`cohort`, every app), the rest folded into "Others". A missing day
 * counts as zero for that app, which is what the data says.
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
  cohort,
  highlight,
  logScale = false,
}: {
  /** ISO days, oldest first, aligned with every line's values. */
  days: string[];
  lines: TradingAppLine[];
  /** Every app in the cohort (same day alignment); enables the share view. */
  cohort?: TradingAppLine[];
  /** Slug drawn on top with full opacity; others dimmed when set. */
  highlight?: string;
  logScale?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [span, setSpan] = useState<30 | 90 | 365 | 100000>(90);
  const hasMoreThanYear = days.length > 365;
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"volume" | "share">("volume");
  const share = mode === "share" && !!cohort;

  const shownDays = useMemo(() => days.slice(-span), [days, span]);
  const shown = useMemo(
    () => lines.map((l) => ({ ...l, values: l.values.slice(-span) })),
    [lines, span],
  );
  const visible = shown.filter((l) => !hidden.has(l.slug));
  const OTHERS = "#8a8a94";
  // Share view: per day, each visible app's share of the cohort total and
  // the cumulative stack (bottom..top), "Others" last.
  const stack = useMemo(() => {
    if (!share || !cohort) return null;
    const nDays = shownDays.length;
    const totals = new Array<number>(nDays).fill(0);
    for (const l of cohort) {
      const vals = l.values.slice(-span);
      for (let i = 0; i < nDays; i++) totals[i] += vals[i] ?? 0;
    }
    const bands: { slug: string; name: string; color: string; lo: number[]; hi: number[]; pct: number[] }[] = [];
    const cum = new Array<number>(nDays).fill(0);
    for (const l of visible) {
      const lo = [...cum];
      const pct = l.values.map((v, i) => (totals[i] > 0 ? ((v ?? 0) / totals[i]) * 100 : 0));
      for (let i = 0; i < nDays; i++) cum[i] += pct[i];
      bands.push({ slug: l.slug, name: l.name, color: l.color, lo, hi: [...cum], pct });
    }
    const restPct = cum.map((c, i) => (totals[i] > 0 ? Math.max(0, 100 - c) : 0));
    bands.push({ slug: "__others", name: "Others", color: OTHERS, lo: [...cum], hi: cum.map((c, i) => c + restPct[i]), pct: restPct });
    return { bands, totals };
  }, [share, cohort, visible, shownDays.length, span]);
  const max = useMemo(
    () => Math.max(1, ...visible.flatMap((l) => l.values.map((v) => v ?? 0))),
    [visible],
  );
  const min = useMemo(() => {
    if (!logScale) return 0;
    const vals = visible.flatMap((l) => l.values.filter((v): v is number => v != null && v > 0));
    return vals.length ? Math.min(...vals) : 1;
  }, [visible, logScale]);
  const top = share ? 100 : niceMax(max);
  const bottom = logScale && !share ? Math.pow(10, Math.floor(Math.log10(Math.max(1, min)))) : 0;

  const W = 1100;
  const H = 320;
  const PAD_L = 56;
  const PAD_R = 64; // room for the end-of-line value labels
  const PAD_T = 16;
  const PAD_B = 30;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const n = shownDays.length;
  const x = (i: number) => PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v: number) => {
    if (logScale && !share) {
      const lo = Math.log10(bottom);
      const hi = Math.log10(top);
      const t = (Math.log10(Math.max(v, bottom)) - lo) / Math.max(hi - lo, 1e-9);
      return PAD_T + plotH - t * plotH;
    }
    return PAD_T + plotH - (v / top) * plotH;
  };

  const ticks = logScale && !share
    ? logTicks(bottom, top)
    : [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const hovered = hover !== null ? shownDays[hover] : null;
  // One tick per month boundary inside the span (first-of-month), or every
  // ~week on the 30-day view.
  const xTicks = useMemo(() => {
    const out: { i: number; label: string }[] = [];
    if (span === 30) {
      for (let i = 0; i < n; i += 7) out.push({ i, label: fmtDate(shownDays[i]) });
      return out;
    }
    const quarterly = n > 400;
    shownDays.forEach((d, i) => {
      if (!d.endsWith("-01")) return;
      if (quarterly && !/-(01|04|07|10)-01$/.test(d)) return;
      out.push({ i, label: fmtMonth(d) });
    });
    return out;
  }, [shownDays, span, n]);
  // Last value per visible line, laid out so the labels don't overlap.
  const endLabels = useMemo(() => {
    const items = visible
      .map((l) => {
        let v: number | null = null;
        for (let i = l.values.length - 1; i >= 0; i--) {
          if (l.values[i] != null) {
            v = l.values[i];
            break;
          }
        }
        return v == null ? null : { slug: l.slug, color: l.color, v, y: y(v) };
      })
      .filter((x): x is { slug: string; color: string; v: number; y: number } => x !== null)
      .sort((a, b) => a.y - b.y);
    const MIN_GAP = 12;
    const lo = PAD_T + 7;
    const hi = PAD_T + plotH - 7;
    for (let i = 1; i < items.length; i++) {
      if (items[i].y - items[i - 1].y < MIN_GAP) items[i].y = items[i - 1].y + MIN_GAP;
    }
    // Keep the stack inside the plot: shift the tail up, then re-separate
    // upwards so nothing overlaps.
    for (let i = items.length - 1; i >= 0; i--) {
      const cap = i === items.length - 1 ? hi : items[i + 1].y - MIN_GAP;
      if (items[i].y > cap) items[i].y = cap;
    }
    for (let i = 0; i < items.length; i++) {
      const floor = i === 0 ? lo : items[i - 1].y + MIN_GAP;
      if (items[i].y < floor) items[i].y = floor;
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, top, bottom, logScale]);

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

  const bandPath = (lo: number[], hi: number[]) => {
    let d = "";
    hi.forEach((v, i) => {
      d += `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    });
    for (let i = lo.length - 1; i >= 0; i--) d += `L${x(i).toFixed(1)},${y(lo[i]).toFixed(1)} `;
    return d + "Z";
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
          {cohort && (
            <div className="inline-flex overflow-hidden rounded border border-rule text-[11px]">
              {(["volume", "share"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`px-2 py-0.5 ${mode === m ? "bg-ink text-paper" : "text-ink-soft hover:text-ink"}`}
                  title={m === "share" ? "Each app's share of the cohort's daily volume, stacked to 100 %" : "Daily volume in USD"}
                >
                  {m === "volume" ? "Volume" : "Share"}
                </button>
              ))}
            </div>
          )}
          <div className="inline-flex overflow-hidden rounded border border-rule text-[11px]">
            {([30, 90, 365, 100000] as const)
              .filter((s) => s !== 100000 || hasMoreThanYear)
              .map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSpan(s)}
                  className={`px-2 py-0.5 ${span === s ? "bg-ink text-paper" : "text-ink-soft hover:text-ink"}`}
                >
                  {s === 100000 ? "All" : s === 365 ? "1y" : `${s}d`}
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
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke="currentColor" strokeOpacity={t === 0 ? 0.2 : 0.07} />
            <text x={PAD_L - 8} y={y(t) + 3} fontSize={10} textAnchor="end" fill="currentColor" fillOpacity={0.5} style={{ fontFamily: "var(--font-mono, monospace)" }}>
              {share ? `${t}%` : t === 0 ? "0" : `$${fmtAxis(t)}`}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <g key={t.i}>
            <line x1={x(t.i)} x2={x(t.i)} y1={PAD_T} y2={PAD_T + plotH} stroke="currentColor" strokeOpacity={0.05} />
            <text x={x(t.i)} y={H - 8} fontSize={10} textAnchor={t.i === 0 ? "start" : "middle"} fill="currentColor" fillOpacity={0.5} style={{ fontFamily: "var(--font-mono, monospace)" }}>
              {t.label}
            </text>
          </g>
        ))}
        {stack
          ? stack.bands.map((b) => {
              const dim = highlight && highlight !== b.slug;
              return (
                <path
                  key={b.slug}
                  d={bandPath(b.lo, b.hi)}
                  fill={b.color}
                  fillOpacity={b.slug === "__others" ? 0.18 : dim ? 0.3 : 0.6}
                  stroke={b.color}
                  strokeOpacity={b.slug === "__others" ? 0.3 : 0.9}
                  strokeWidth={0.8}
                />
              );
            })
          : visible.map((l) => {
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
            {!stack &&
              visible.map((l) => {
                const v = l.values[hover];
                if (v == null) return null;
                return <circle key={l.slug} cx={x(hover)} cy={y(v)} r={3} fill={l.color} />;
              })}
          </g>
        )}
        {hover === null &&
          !stack &&
          endLabels.map((e) => (
            <g key={e.slug}>
              <rect x={W - PAD_R + 6} y={e.y - 7} width={PAD_R - 10} height={14} rx={3} fill={e.color} fillOpacity={0.14} />
              <text x={W - PAD_R + 10} y={e.y + 3.5} fontSize={10} fill={e.color} style={{ fontFamily: "var(--font-mono, monospace)" }}>
                {fmtUsdShort(e.v)}
              </text>
            </g>
          ))}
        {hover === null &&
          stack &&
          stack.bands
            .filter((b) => b.pct[n - 1] >= 3)
            .map((b) => {
              const mid = (b.lo[n - 1] + b.hi[n - 1]) / 2;
              return (
                <text key={b.slug} x={W - PAD_R + 8} y={y(mid) + 3.5} fontSize={10} fill={b.color} style={{ fontFamily: "var(--font-mono, monospace)" }}>
                  {b.pct[n - 1].toFixed(0)}% {b.name === "Others" ? "others" : ""}
                </text>
              );
            })}
        <text x={W - PAD_R} y={H - 8} fontSize={10} textAnchor="end" fill="currentColor" fillOpacity={0.5} style={{ fontFamily: "var(--font-mono, monospace)" }}>
          {fmtDate(shownDays.at(-1) ?? "")}
        </text>
      </svg>

      {hover !== null && (
        <div className="pointer-events-none absolute right-2 top-9 rounded-md border border-rule bg-paper px-3 py-2 shadow-xl text-[11px] tabular-nums">
          <p className="mb-1 text-ink-faint">{fmtDate(shownDays[hover])}</p>
          {stack ? (
            <>
              {[...stack.bands]
                .sort((a, b) => b.pct[hover] - a.pct[hover])
                .map((b) => (
                  <p key={b.slug} className="flex items-center justify-between gap-4">
                    <span className="inline-flex items-center gap-1.5 text-ink-soft">
                      <i className="inline-block h-2 w-2 rounded-sm" style={{ background: b.color }} />
                      {b.name}
                    </span>
                    <span className="text-ink">{b.pct[hover].toFixed(1)}%</span>
                  </p>
                ))}
              <p className="mt-1 border-t border-rule pt-1 flex items-center justify-between gap-4 text-ink-faint">
                <span>Cohort</span>
                <span>{fmtUsd(stack.totals[hover])}</span>
              </p>
            </>
          ) : (
            [...visible]
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
              ))
          )}
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

function fmtUsdShort(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtMonth(iso: string): string {
  const [y, m] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mo = months[parseInt(m, 10) - 1];
  return m === "01" ? `${mo} ${y}` : mo;
}

function fmtDate(iso: string): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}
