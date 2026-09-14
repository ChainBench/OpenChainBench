"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fmtUnit } from "@/lib/format";
import { brandColor } from "@/lib/brand";
import { lineColor } from "@/lib/series-colors";

type Range = "7d" | "30d" | "90d";
const RANGES: Range[] = ["7d", "30d", "90d"];
/** Selected view / range pill: the site accent, so the active choice
 *  reads at a glance against the ink pills of the surrounding card. */
const ACTIVE_PILL = "bg-accent text-white shadow-sm";

/** One selectable view: the bench headline metric or one of its panels. */
export type TrendView = {
  /** "main" for the headline series, otherwise the metric_panels id. */
  id: string;
  label: string;
  unit: string;
};

type SeriesPayload = {
  timestamps: number[];
  providers: { slug: string; values: (number | null)[] }[];
};

/**
 * History behind a compare card: the two providers' series for one
 * shared bench, with the same view tabs the bench page offers (headline
 * metric plus every metric panel) and a 7d / 30d / 90d range. Reads
 * /api/series filtered to the pair, fetched when the card scrolls near
 * the viewport, cached per (view, range) for the session.
 */
export function CompareTrendChart({
  benchSlug,
  views,
  aSlug,
  bSlug,
  aName,
  bName,
}: {
  benchSlug: string;
  views: TrendView[];
  aSlug: string;
  bSlug: string;
  aName: string;
  bName: string;
}) {
  const [viewId, setViewId] = useState(views[0]?.id ?? "main");
  const [range, setRange] = useState<Range>("30d");
  const [cache, setCache] = useState<Record<string, SeriesPayload | null>>({});
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const [hover, setHover] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const view = views.find((v) => v.id === viewId) ?? views[0];
  const key = `${viewId}:${range}`;

  useEffect(() => {
    const el = rootRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || key in cache) return;
    let cancelled = false;
    const qs = new URLSearchParams({ range, raw: "1", providers: `${aSlug},${bSlug}` });
    if (viewId !== "main") qs.set("panel", viewId);
    fetch(`/api/series/${benchSlug}?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: SeriesPayload | null) => {
        if (!cancelled) setCache((c) => ({ ...c, [key]: json }));
      })
      .catch(() => {
        if (!cancelled) setCache((c) => ({ ...c, [key]: null }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, key]);

  const payload = key in cache ? cache[key] : undefined;
  const series = useMemo(() => {
    if (!payload) return null;
    const pick = (slug: string) => payload.providers.find((p) => p.slug === slug)?.values ?? [];
    const a = pick(aSlug);
    const b = pick(bSlug);
    const n = Math.max(a.length, b.length, payload.timestamps.length);
    if (n === 0) return null;
    // Both sides must have at least one point: a one-sided chart reads
    // as a comparison with a missing opponent, so the card hides it.
    if (!a.some((v) => v !== null) || !b.some((v) => v !== null)) return null;
    return { a, b, ts: payload.timestamps, n };
  }, [payload, aSlug, bSlug]);

  const aColor = brandColor(aSlug) ?? lineColor(0);
  const bColor = brandColor(bSlug) ?? lineColor(1);
  const unit = view?.unit ?? "";
  const fmt = (v: number | null | undefined) =>
    v === null || v === undefined || !Number.isFinite(v) ? "n/a" : fmtUnit(v, unit);

  // Geometry
  const W = 820;
  const H = 200;
  const PAD_L = 62;
  const PAD_R = 14;
  const PAD_T = 12;
  const PAD_B = 26;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const scale = useMemo(() => {
    if (!series) return null;
    const vals = [...series.a, ...series.b].filter(
      (v): v is number => v !== null && Number.isFinite(v),
    );
    const rawMax = Math.max(...vals);
    const rawMin = Math.min(...vals);
    const lo = rawMin < 0 ? niceFloor(rawMin) : 0;
    const hi = rawMax > 0 ? niceCeil(rawMax) : lo === 0 ? 1 : 0;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * (hi - lo));
    return { lo, hi, ticks };
  }, [series]);

  const x = (i: number) =>
    PAD_L + (!series || series.n <= 1 ? plotW / 2 : (i / (series.n - 1)) * plotW);
  const y = (v: number) =>
    !scale ? PAD_T + plotH : PAD_T + plotH - ((v - scale.lo) / (scale.hi - scale.lo || 1)) * plotH;

  const linePath = (arr: (number | null)[]) => {
    let d = "";
    let open = false;
    arr.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        open = false;
        return;
      }
      d += `${open ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      open = true;
    });
    return d;
  };
  const areaPath = (arr: (number | null)[]) => {
    // One closed area per contiguous run, down to the zero line.
    const base = y(Math.max(0, scale?.lo ?? 0));
    let d = "";
    let start: number | null = null;
    arr.forEach((v, i) => {
      const ok = v !== null && Number.isFinite(v);
      if (ok && start === null) {
        start = i;
        d += `M${x(i).toFixed(1)},${base.toFixed(1)}`;
      }
      if (ok) d += `L${x(i).toFixed(1)},${y(v as number).toFixed(1)}`;
      const last = i === arr.length - 1;
      if ((!ok || last) && start !== null) {
        const endIdx = ok ? i : i - 1;
        d += `L${x(endIdx).toFixed(1)},${base.toFixed(1)}Z`;
        start = null;
      }
    });
    return d;
  };

  const lastIdx = (arr: (number | null)[]) => {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null) return i;
    return -1;
  };
  const shownIdx = hover ?? (series ? Math.max(lastIdx(series.a), lastIdx(series.b)) : -1);
  const shown =
    series && shownIdx >= 0
      ? { a: series.a[shownIdx] ?? null, b: series.b[shownIdx] ?? null, t: series.ts[shownIdx] }
      : null;

  const xLabels = useMemo(() => {
    if (!series || series.n < 2) return [];
    const idx = [0, Math.floor((series.n - 1) / 2), series.n - 1];
    return idx.map((i) => ({ i, label: fmtTs(series.ts[i], range) }));
  }, [series, range]);

  // Confirmed empty for the initial view/range: hide the block rather than
  // show an empty frame. Once the user has interacted we keep the frame so
  // the tabs stay reachable and say so inline.
  const [touched, setTouched] = useState(false);
  if (payload !== undefined && !series && !touched) return <div ref={rootRef} />;

  return (
    <div ref={rootRef} className="mt-5 rounded-lg border border-rule bg-paper p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {views.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[10px] uppercase tracking-[0.16em] text-ink-faint">View</span>
            {views.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => {
                  setTouched(true);
                  setViewId(v.id);
                }}
                className={[
                  "rounded px-2.5 py-1 text-[11px] font-sans uppercase tracking-[0.1em] font-medium transition-colors",
                  v.id === viewId ? ACTIVE_PILL : "text-ink-muted hover:text-ink hover:bg-paper-soft",
                ].join(" ")}
              >
                {v.label}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            {view?.label}
          </span>
        )}
        <div className="flex items-center gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => {
                setTouched(true);
                setRange(r);
              }}
              className={[
                "rounded px-2.5 py-1 text-[11px] font-sans uppercase tracking-[0.1em] font-medium transition-colors",
                r === range ? ACTIVE_PILL : "text-ink-muted hover:text-ink hover:bg-paper-soft",
              ].join(" ")}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
          <span className="inline-flex items-baseline gap-2">
            <i className="inline-block h-[3px] w-4 translate-y-[-3px] rounded" style={{ background: aColor }} />
            <span className="text-ink-soft">{aName}</span>
            <span className="tabular-nums font-medium text-ink">{fmt(shown?.a)}</span>
          </span>
          <span className="inline-flex items-baseline gap-2">
            <i className="inline-block h-[3px] w-4 translate-y-[-3px] rounded" style={{ background: bColor }} />
            <span className="text-ink-soft">{bName}</span>
            <span className="tabular-nums font-medium text-ink">{fmt(shown?.b)}</span>
          </span>
        </div>
        <span
          className="text-[11px] tabular-nums text-ink-faint"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {shown ? (hover !== null ? fmtTs(shown.t, range, true) : `latest · ${fmtTs(shown.t, range, true)}`) : ""}
        </span>
      </div>

      {payload === undefined && (
        <div className="mt-3 h-[200px] w-full animate-pulse rounded bg-paper-soft" aria-hidden />
      )}
      {payload !== undefined && !series && (
        <p className="mt-3 py-10 text-center text-xs text-ink-faint">
          No series for this view over the last {range}.
        </p>
      )}
      {series && scale && (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="mt-2 w-full"
          role="img"
          aria-label={`${view?.label}: ${aName} vs ${bName}, last ${range}`}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={`ga-${benchSlug}-${viewId}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={aColor} stopOpacity={0.18} />
              <stop offset="100%" stopColor={aColor} stopOpacity={0} />
            </linearGradient>
            <linearGradient id={`gb-${benchSlug}-${viewId}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={bColor} stopOpacity={0.18} />
              <stop offset="100%" stopColor={bColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          {scale.ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y(t)}
                y2={y(t)}
                stroke="currentColor"
                strokeOpacity={t === 0 || t === scale.lo ? 0.3 : 0.07}
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
                {fmt(t)}
              </text>
            </g>
          ))}
          <path d={areaPath(series.a)} fill={`url(#ga-${benchSlug}-${viewId})`} />
          <path d={areaPath(series.b)} fill={`url(#gb-${benchSlug}-${viewId})`} />
          <path d={linePath(series.a)} fill="none" stroke={aColor} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <path d={linePath(series.b)} fill="none" stroke={bColor} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {isolated(series.a).map((i) => (
            <circle key={`ia-${i}`} cx={x(i)} cy={y(series.a[i] as number)} r={3} fill={aColor} />
          ))}
          {isolated(series.b).map((i) => (
            <circle key={`ib-${i}`} cx={x(i)} cy={y(series.b[i] as number)} r={3} fill={bColor} />
          ))}
          {shownIdx >= 0 && (
            <g>
              <line
                x1={x(shownIdx)}
                x2={x(shownIdx)}
                y1={PAD_T}
                y2={PAD_T + plotH}
                stroke="currentColor"
                strokeOpacity={hover !== null ? 0.3 : 0.12}
                strokeDasharray={hover !== null ? undefined : "2 3"}
              />
              {series.a[shownIdx] !== null && (
                <circle cx={x(shownIdx)} cy={y(series.a[shownIdx] as number)} r={3.5} fill={aColor} stroke="var(--color-paper)" strokeWidth={1.5} />
              )}
              {series.b[shownIdx] !== null && (
                <circle cx={x(shownIdx)} cy={y(series.b[shownIdx] as number)} r={3.5} fill={bColor} stroke="var(--color-paper)" strokeWidth={1.5} />
              )}
            </g>
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
          {xLabels.map(({ i, label }, k) => (
            <text
              key={i}
              x={x(i)}
              y={H - 8}
              textAnchor={k === 0 ? "start" : k === xLabels.length - 1 ? "end" : "middle"}
              fontSize={10}
              fill="currentColor"
              fillOpacity={0.55}
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              {label}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

/** Indices of points with no non-null neighbour: a line cannot show them. */
function isolated(arr: (number | null)[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === null) continue;
    const prev = i > 0 ? arr[i - 1] : null;
    const next = i < arr.length - 1 ? arr[i + 1] : null;
    if (prev === null && next === null) out.push(i);
  }
  return out;
}

function niceCeil(v: number): number {
  if (v <= 0) return 0;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / exp;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 4 ? 4 : m <= 5 ? 5 : m <= 8 ? 8 : 10;
  return step * exp;
}

function niceFloor(v: number): number {
  return -niceCeil(-v);
}

function fmtTs(ms: number | undefined, range: Range, withTime = false): string {
  if (!ms) return "";
  const d = new Date(ms);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (range === "7d" || withTime) {
    return `${day} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
  }
  return day;
}
