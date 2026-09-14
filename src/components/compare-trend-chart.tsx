"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fmtUnit } from "@/lib/format";
import { brandColor } from "@/lib/brand";
import { lineColor } from "@/lib/series-colors";

type Range = "7d" | "30d" | "90d";

type SeriesPayload = {
  timestamps: number[];
  providers: { slug: string; values: (number | null)[] }[];
};

/**
 * Two-line trend for one shared bench on a compare page: the same
 * /api/series the bench page reads, filtered to the pair, so every
 * compare card carries the history behind its two headline numbers
 * rather than a single 24h figure. Fetched when the card scrolls into
 * view (a pair shares up to a dozen benches) and cached per range.
 * Hidden when neither side has a point in the window.
 */
export function CompareTrendChart({
  benchSlug,
  unit,
  aSlug,
  bSlug,
  aName,
  bName,
}: {
  benchSlug: string;
  unit: string;
  aSlug: string;
  bSlug: string;
  aName: string;
  bName: string;
}) {
  const [range, setRange] = useState<Range>("30d");
  const [data, setData] = useState<Partial<Record<Range, SeriesPayload | null>>>({});
  // Starts visible when IntersectionObserver is unavailable (old
  // browsers, SSR) so the chart still loads; otherwise waits for the
  // card to scroll near the viewport.
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const [hover, setHover] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || range in data) return;
    let cancelled = false;
    const qs = new URLSearchParams({ range, raw: "1", providers: `${aSlug},${bSlug}` });
    fetch(`/api/series/${benchSlug}?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: SeriesPayload | null) => {
        if (cancelled) return;
        setData((d) => ({ ...d, [range]: json }));
      })
      .catch(() => {
        if (!cancelled) setData((d) => ({ ...d, [range]: null }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, range, benchSlug, aSlug, bSlug]);

  const payload = data[range];
  const series = useMemo(() => {
    if (!payload) return null;
    const pick = (slug: string) =>
      payload.providers.find((p) => p.slug === slug)?.values ?? [];
    const a = pick(aSlug);
    const b = pick(bSlug);
    const n = Math.max(a.length, b.length, payload.timestamps.length);
    if (n === 0) return null;
    const hasA = a.some((v) => v !== null);
    const hasB = b.some((v) => v !== null);
    if (!hasA && !hasB) return null;
    return { a, b, ts: payload.timestamps, n };
  }, [payload, aSlug, bSlug]);

  const aColor = brandColor(aSlug) ?? lineColor(0);
  const bColor = brandColor(bSlug) ?? lineColor(1);

  // Nothing yet, or confirmed empty: keep the card's layout stable with
  // a slim placeholder only while loading; render nothing on empty.
  if (payload === null || (payload && !series)) return <div ref={rootRef} />;
  if (!series) {
    return (
      <div ref={rootRef} className="mt-4 h-24 rounded border border-dashed border-rule" aria-hidden />
    );
  }

  const W = 800;
  const H = 170;
  const PAD_L = 54;
  const PAD_R = 8;
  const PAD_T = 10;
  const PAD_B = 20;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const vals = [...series.a, ...series.b].filter((v): v is number => v !== null && Number.isFinite(v));
  const max = Math.max(...vals, 0);
  const min = Math.min(...vals, 0);
  const span = max - min || 1;
  const x = (i: number) => PAD_L + (series.n <= 1 ? plotW / 2 : (i / (series.n - 1)) * plotW);
  const y = (v: number) => PAD_T + plotH - ((v - min) / span) * plotH;
  const path = (arr: (number | null)[]) => {
    const segs: string[] = [];
    let cur = "";
    arr.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        if (cur) segs.push(cur);
        cur = "";
        return;
      }
      cur += `${cur ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    if (cur) segs.push(cur);
    return segs.join(" ");
  };
  const hv = hover !== null ? { a: series.a[hover] ?? null, b: series.b[hover] ?? null, t: series.ts[hover] } : null;
  const fmt = (v: number | null) => (v === null ? "n/a" : fmtUnit(v, unit));
  const first = series.ts[0];
  const last = series.ts[series.n - 1];

  return (
    <div ref={rootRef} className="mt-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-3 text-ink-soft">
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-0.5 w-3" style={{ background: aColor }} />
            {aName}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-0.5 w-3" style={{ background: bColor }} />
            {bName}
          </span>
          {hv && (
            <span
              className="tabular-nums text-ink-muted"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              {fmtTs(hv.t, range)} · {fmt(hv.a)} vs {fmt(hv.b)}
            </span>
          )}
        </div>
        <div className="inline-flex overflow-hidden rounded border border-rule">
          {(["7d", "30d", "90d"] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`px-2 py-0.5 ${range === r ? "bg-ink text-paper" : "text-ink-soft hover:text-ink"}`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`${aName} vs ${bName}, last ${range}`}
        onMouseLeave={() => setHover(null)}
      >
        {[0, 0.5, 1].map((f) => {
          const v = min + f * span;
          return (
            <g key={f}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y(v)}
                y2={y(v)}
                stroke="currentColor"
                strokeOpacity={f === 0 ? 0.25 : 0.08}
              />
              <text
                x={PAD_L - 6}
                y={y(v) + 3}
                textAnchor="end"
                fontSize={9}
                fill="currentColor"
                fillOpacity={0.55}
                style={{ fontFamily: "var(--font-mono, monospace)" }}
              >
                {fmtUnit(v, unit)}
              </text>
            </g>
          );
        })}
        <path d={path(series.a)} fill="none" stroke={aColor} strokeWidth={1.8} strokeLinejoin="round" />
        <path d={path(series.b)} fill="none" stroke={bColor} strokeWidth={1.8} strokeLinejoin="round" />
        {hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={PAD_T + plotH} stroke="currentColor" strokeOpacity={0.3} />
        )}
        {Array.from({ length: series.n }, (_, i) => (
          <rect
            key={i}
            x={x(i) - plotW / series.n / 2}
            y={0}
            width={plotW / series.n}
            height={H}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
        <text x={PAD_L} y={H - 5} fontSize={9} fill="currentColor" fillOpacity={0.5} style={{ fontFamily: "var(--font-mono, monospace)" }}>
          {fmtTs(first, range)}
        </text>
        <text x={W - PAD_R} y={H - 5} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.5} style={{ fontFamily: "var(--font-mono, monospace)" }}>
          {fmtTs(last, range)}
        </text>
      </svg>
    </div>
  );
}

function fmtTs(ms: number | undefined, range: Range): string {
  if (!ms) return "";
  const d = new Date(ms);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (range === "7d") return `${day} ${String(d.getUTCHours()).padStart(2, "0")}:00`;
  return day;
}
