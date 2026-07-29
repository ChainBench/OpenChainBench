"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Globe } from "lucide-react";
import type { Benchmark } from "@/types/benchmark";
import { brandColor } from "@/lib/brand";
import { buildProviderColors } from "@/lib/series-colors";
import { useChartExclusion } from "@/hooks/use-chart-exclusion";
import { useTopN } from "@/hooks/use-top-n";
import { LiveDot } from "@/components/live-dot";
import { ChartExportButton } from "@/components/chart-export-button";
import { TopNSelector } from "@/components/top-n-selector";
import {
  RANGES,
  LONG_RANGES,
  RANGE_HOURS,
  RANGE_EXPECTED_POINTS,
  RANGE_LABEL,
  REGION_LABEL,
  pickSeries,
  mean,
  type Range,
  type LineWithColor,
} from "./scales";
import { Chart } from "./chart";

type Props = {
  benchmark: Benchmark;
  /** Optional externally-controlled region. When provided, the chart
   *  filters its lines by this value and hides its internal region tabs
   *  (the parent component renders them in a shared dimension row). */
  region?: string;
  /** Optional externally-controlled chain. Forwarded to `/api/series` on
   *  the lazy 7d/30d fetch so the returned sparklines are scoped to the
   *  same chain the page is currently filtering by. Without this, changing
   *  the chain tab kept the 7d/30d chart on the previously loaded chain's
   *  data because the fetch URL had no chain param. */
  chain?: string;
  /** Optional controlled exclusion set shared with the other chart views
   *  (ranked-bar, distribution, donut). Lets the reader hide a dominant
   *  outlier here too — Y-axis re-zooms smoothly to fit the rest. */
  excluded?: Set<string>;
  onToggleExclude?: (slug: string) => void;
  onResetExcluded?: () => void;
  /** Optional slot rendered in the chart's header row, right-aligned. */
  headerActions?: import("react").ReactNode;
  /** Optional metric-panel override. When set, the chart pulls its per-
   *  provider series from `seriesOverride[slug]` instead of
   *  `benchmark.extras.series24h[slug]`, swaps the metric name in the
   *  header, and switches the Y-axis unit. Used by the bench page when
   *  the reader selects a companion metric from the panel tab row. */
  seriesOverride?: Record<string, (number | null)[]>;
  /** Optional 7 day and 30 day variants of the panel override. The chart
   *  picks the matching one when the range tab is 7d or 30d. */
  seriesOverride7d?: Record<string, (number | null)[]>;
  seriesOverride30d?: Record<string, (number | null)[]>;
  /** Panel id that produced the seriesOverride*. When set (and no
   *  seriesOverride7d/30d were passed inline — the common case since
   *  slimBenchmarkForCache strips those to keep cache entries small),
   *  the chart lazy-fetches /api/series?panel=<id>&range=7d|30d and
   *  drives the long-range tabs from the response. Without this, 7d
   *  and 30d pills stayed disabled whenever a metric panel was active
   *  even though the underlying Prom data existed. */
  activePanelId?: string | null;
  metricLabelOverride?: string;
  unitOverride?: Benchmark["unit"];
  /** Direction override for ranking when a metric panel is active. Bench
   *  level higher_is_better doesn't apply to companion metrics with
   *  inverse semantics (effective fee bps lower is better, time since
   *  last fill lower is better). When set, the chart's Top N selector
   *  picks the BEST N rather than the BIGGEST N. */
  higherIsBetterOverride?: boolean;
  topNControl?: { topN: number | null; setTopN: (n: number | null) => void };
  disableTopN?: boolean;
  /** Externally-controlled range. When provided, the chart relinquishes
   *  its internal `range` state and lets the parent drive it (so a sister
   *  component below — e.g. a leaderboard table — can stay in sync with
   *  the pill selection). */
  range?: Range;
  onRangeChange?: (r: Range) => void;
  /** Optional long-range tabs (90d / 180d / 1y / all). When set, the chart
   *  renders these pills after the live ones AND reads per-provider series
   *  from this map when the selected range is one of them. Each entry's
   *  value array is plotted as-is — typically one sample per day from the
   *  archive backend. Missing entries render an empty line. */
  longRangeSeries?: Partial<Record<Range, Record<string, number[]>>>;
  /** When true, the long-range pills render in a disabled state with a
   *  "soon" hint. Used when the archive is unreachable. */
  longRangeDisabled?: boolean;
  /** Tooltip surfaced on disabled long-range pills (e.g. "Archive
   *  temporarily unavailable"). */
  longRangeDisabledTitle?: string;
};

export function TimeSeriesChart({
  benchmark,
  region: regionProp,
  chain: chainProp,
  excluded: controlledExcluded,
  onToggleExclude,
  seriesOverride,
  seriesOverride7d,
  seriesOverride30d,
  activePanelId,
  metricLabelOverride,
  unitOverride,
  higherIsBetterOverride,
  onResetExcluded,
  topNControl,
  disableTopN,
  headerActions,
  range: rangeProp,
  onRangeChange,
  longRangeSeries,
  longRangeDisabled,
  longRangeDisabledTitle,
}: Props) {
  const [rangeLocal, setRangeLocal] = useState<Range>("24h");
  const range = rangeProp ?? rangeLocal;
  const setRange = (next: Range) => {
    if (onRangeChange) onRangeChange(next);
    if (rangeProp == null) setRangeLocal(next);
  };
  const isLongRange = (LONG_RANGES as readonly Range[]).includes(range);
  const [regionLocal, setRegionLocal] = useState<string>("all");
  const region = regionProp ?? regionLocal;
  const setRegion = regionProp != null ? () => {} : setRegionLocal;
  const { excluded, toggle, reset } = useChartExclusion(
    controlledExcluded,
    onToggleExclude,
    onResetExcluded,
  );
  // Drag-to-zoom state. Fractions are 0..1 of the original visible range
  // for the current Range tab. Lives in the parent so it survives the
  // Chart's internal re-renders. Reset to null when range or region
  // changes (the data shape is different, the old zoom doesn't apply).
  const [zoom, setZoom] = useState<{ startFrac: number; endFrac: number } | null>(null);
  const figureRef = useRef<HTMLElement | null>(null);
  // Points to just the SVG+legend block so the exported PNG captures
  // only the chart body — the omitted header/pills divs still occupy
  // layout space inside <figure> and would create blank whitespace at
  // the top of the image if we used figureRef as the export target.
  const chartBodyRef = useRef<HTMLDivElement | null>(null);
  const zoomScopeKey = `${range}|${region}`;
  const [prevZoomScopeKey, setPrevZoomScopeKey] = useState(zoomScopeKey);
  if (prevZoomScopeKey !== zoomScopeKey) {
    setPrevZoomScopeKey(zoomScopeKey);
    setZoom(null);
  }

  // 7d / 30d series are no longer included in the server-rendered
  // Benchmark — they were pushing heavy benches past unstable_cache's
  // 2 MB ceiling, silently breaking the cache and forcing every render
  // to re-query Prom. They are now lazy-fetched via /api/series on the
  // first 7d or 30d tab click, then cached in component state for the
  // rest of the session. CDN cache-control on /api/series (60 s
  // s-maxage + 300 s SWR) absorbs concurrent visitors so Prom sees at
  // most one fan-out per (bench, range) per minute.
  const [lazySeries7d, setLazySeries7d] = useState<Record<string, (number | null)[]> | null>(null);
  const [lazySeries30d, setLazySeries30d] = useState<Record<string, (number | null)[]> | null>(null);
  // Per-panel lazy series, keyed by panel id. Cached across a panel
  // switch so flipping back to a previously-viewed panel is instant.
  // 7d/30d: fetched on panel activation. 90d/1y: fetched on-demand when
  // the user clicks those tabs (Prom-backed, not archive-backed).
  const [lazyPanel7d, setLazyPanel7d] = useState<Record<string, Record<string, (number | null)[]>>>({});
  const [lazyPanel30d, setLazyPanel30d] = useState<Record<string, Record<string, (number | null)[]>>>({});
  const [lazyPanel90d, setLazyPanel90d] = useState<Record<string, Record<string, (number | null)[]>>>({});
  const [lazyPanel1y, setLazyPanel1y] = useState<Record<string, Record<string, (number | null)[]>>>({});

  // Pre-fetch 7d AND 30d in the background as soon as the chart mounts,
  // not just when the user clicks the tab. The fetches are non-blocking
  // (24h renders synchronously from props) and the CDN dedupes
  // concurrent visitors (60 s s-maxage + 300 s SWR on /api/series), so
  // by the time the reader actually flips to a longer range the data is
  // already in component state. Removes the 5–15 s cold-fetch lag that
  // made the first tab click feel broken.
  useEffect(() => {
    let cancelled = false;
    // Tracks per-range whether we've already landed data OR exhausted retries.
    // The previous version put `lazySeries7d` in the effect's deps and used
    // `if (lazySeries7d) return` as the skip guard, so an empty `{}` written
    // on the first failed fetch was treated as "already fetched" forever —
    // the chart stayed empty for the whole session even after the upstream
    // recovered. Trigger: Prom returned 503 for ~30 min during a TSDB
    // backfill; every chart that mounted in that window cached `{}` and
    // never refetched.
    const done: Record<"7d" | "30d", boolean> = { "7d": false, "30d": false };
    const buildQs = (range: "7d" | "30d") => {
      const qs = new URLSearchParams({ range, raw: "1" });
      if (regionProp && regionProp !== "all") qs.set("region", regionProp);
      if (chainProp && chainProp !== "all") qs.set("chain", chainProp);
      return qs.toString();
    };
    const fetchOne = (range: "7d" | "30d", attempt = 0) => {
      if (cancelled || done[range]) return;
      fetch(`/api/series/${benchmark.slug}?${buildQs(range)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((data: { providers: { slug: string; values: (number | null)[] }[] }) => {
          if (cancelled) return;
          done[range] = true;
          const map: Record<string, (number | null)[]> = {};
          for (const p of data.providers) map[p.slug] = p.values;
          if (range === "7d") setLazySeries7d(map);
          else setLazySeries30d(map);
        })
        .catch(() => {
          if (cancelled) return;
          // 2s → 4s backoff, ~6s total window. Covers a Prom hiccup,
          // an in-flight ISR regen, or a Vercel cold-start lag without
          // bothering the user. Past that we commit to the empty
          // placeholder so the chart doesn't spin forever.
          if (attempt < 2) {
            setTimeout(() => fetchOne(range, attempt + 1), (attempt + 1) * 2000);
          } else {
            done[range] = true;
            if (range === "7d") setLazySeries7d({});
            else setLazySeries30d({});
          }
        });
    };
    fetchOne("7d");
    fetchOne("30d");
    return () => {
      cancelled = true;
    };
  }, [regionProp, chainProp, benchmark.slug]);

  // Panel-scoped lazy fetch. Runs when the active panel id changes and the
  // parent did NOT ship the panel's own 7d/30d series inline (the common
  // case since slimBenchmarkForCache drops them). Cache-keyed per panel so
  // switching between panels re-uses previously loaded data instantly.
  useEffect(() => {
    if (!activePanelId) return;
    // Inline overrides win — skip the fetch when the parent already
    // supplied panel long-range series (e.g. an unshimmed test caller).
    if (seriesOverride7d && seriesOverride30d) return;
    if (lazyPanel7d[activePanelId] && lazyPanel30d[activePanelId]) return;
    let cancelled = false;
    const need7d = !seriesOverride7d && !lazyPanel7d[activePanelId];
    const need30d = !seriesOverride30d && !lazyPanel30d[activePanelId];
    const done: Record<"7d" | "30d", boolean> = {
      "7d": !need7d,
      "30d": !need30d,
    };
    const buildQs = (range: "7d" | "30d") => {
      const qs = new URLSearchParams({ range, panel: activePanelId, raw: "1" });
      if (regionProp && regionProp !== "all") qs.set("region", regionProp);
      if (chainProp && chainProp !== "all") qs.set("chain", chainProp);
      return qs.toString();
    };
    const fetchOne = (range: "7d" | "30d", attempt = 0) => {
      if (cancelled || done[range]) return;
      fetch(`/api/series/${benchmark.slug}?${buildQs(range)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((data: { providers: { slug: string; values: (number | null)[] }[] }) => {
          if (cancelled) return;
          done[range] = true;
          const map: Record<string, (number | null)[]> = {};
          for (const p of data.providers) map[p.slug] = p.values;
          if (range === "7d") {
            setLazyPanel7d((prev) => ({ ...prev, [activePanelId]: map }));
          } else {
            setLazyPanel30d((prev) => ({ ...prev, [activePanelId]: map }));
          }
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt < 2) {
            setTimeout(() => fetchOne(range, attempt + 1), (attempt + 1) * 2000);
          } else {
            done[range] = true;
            if (range === "7d") {
              setLazyPanel7d((prev) => ({ ...prev, [activePanelId]: {} }));
            } else {
              setLazyPanel30d((prev) => ({ ...prev, [activePanelId]: {} }));
            }
          }
        });
    };
    if (need7d) fetchOne("7d");
    if (need30d) fetchOne("30d");
    return () => {
      cancelled = true;
    };
    // Deliberately excluding lazyPanel7d/30d from deps — the effect reads
    // them for its "already cached?" guard, but re-triggering when the
    // maps mutate would deadloop with the setState calls inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanelId, regionProp, chainProp, benchmark.slug, seriesOverride7d, seriesOverride30d]);

  // Lazy fetch for 90d / 1y panel series. These are Prom-backed (not
  // archive-backed) so the fetch goes to /api/series?panel=<id>&range=90d.
  // Triggered the first time a panel becomes active — we prefetch both
  // ranges so the user can switch between them without extra round-trips.
  useEffect(() => {
    if (!activePanelId) return;
    const need90d = !lazyPanel90d[activePanelId];
    const need1y = !lazyPanel1y[activePanelId];
    if (!need90d && !need1y) return;
    let cancelled = false;
    const buildQs = (r: "90d" | "1y") => {
      const qs = new URLSearchParams({ range: r, panel: activePanelId, raw: "1" });
      if (regionProp && regionProp !== "all") qs.set("region", regionProp);
      if (chainProp && chainProp !== "all") qs.set("chain", chainProp);
      return qs.toString();
    };
    const fetchOne = (r: "90d" | "1y") => {
      if (cancelled) return;
      fetch(`/api/series/${benchmark.slug}?${buildQs(r)}`)
        .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
        .then((data: { providers: { slug: string; values: (number | null)[] }[] }) => {
          if (cancelled) return;
          const map: Record<string, (number | null)[]> = {};
          for (const p of data.providers) map[p.slug] = p.values;
          if (r === "90d") setLazyPanel90d((prev) => ({ ...prev, [activePanelId]: map }));
          else setLazyPanel1y((prev) => ({ ...prev, [activePanelId]: map }));
        })
        .catch(() => {
          if (cancelled) return;
          if (r === "90d") setLazyPanel90d((prev) => ({ ...prev, [activePanelId]: {} }));
          else setLazyPanel1y((prev) => ({ ...prev, [activePanelId]: {} }));
        });
    };
    if (need90d) fetchOne("90d");
    if (need1y) fetchOne("1y");
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanelId, regionProp, chainProp, benchmark.slug]);

  const panelActive = !!seriesOverride;
  const panelLazy7d = activePanelId ? lazyPanel7d[activePanelId] : undefined;
  const panelLazy30d = activePanelId ? lazyPanel30d[activePanelId] : undefined;
  const panelLazy90d = activePanelId ? lazyPanel90d[activePanelId] : undefined;
  const panelLazy1y = activePanelId ? lazyPanel1y[activePanelId] : undefined;
  const has7d =
    !panelActive ||
    !!seriesOverride7d ||
    (!!activePanelId && panelLazy7d !== undefined);
  const has30d =
    !panelActive ||
    !!seriesOverride30d ||
    (!!activePanelId && panelLazy30d !== undefined);

  const availableRegions = useMemo(() => {
    const set = new Set<string>();
    const byRegion = benchmark.extras.seriesByRegion24h ?? {};
    for (const slug of Object.keys(byRegion)) {
      for (const r of Object.keys(byRegion[slug])) set.add(r);
    }
    return Array.from(set).sort();
  }, [benchmark]);

  // Internal region tabs are hidden when the parent controls the region -
  // it renders a unified Chain + Region row above and passes the value down.
  const showRegionTabs = regionProp == null && availableRegions.length > 1;

  const colors = useMemo(
    () => buildProviderColors(benchmark.results),
    [benchmark.results]
  );

  // Build every provider's line up-front so the legend always lists the
  // full set (excluded items stay visible there for re-enable). The
  // `excluded` flag drives both opacity (CSS fade-out) and Y-axis math
  // (excluded values are dropped from min/max so the remaining lines
  // can spread out vertically when an outlier is hidden).
  const allLines = useMemo(() => {
    // Panel overrides ship in up to three variants: 24h (72 pts), 7d (84
    // pts) and 30d (60 pts). When the chart range is 7d or 30d we pick
    // the matching variant if it exists. Sub 24h tabs slice the 24h
    // variant trailing edge. Long range tabs fall back to the 24h
    // variant when the longer one is missing (older specs).
    const pickPanel = (): Record<string, (number | null)[]> | undefined => {
      // Prefer inline overrides (present when parent chose to ship panel
      // long-range series with the initial payload), then lazy-fetched
      // panel maps (the common path — long-range series are stripped
      // from the cached bench and loaded via /api/series?panel=<id>),
      // then fall back to the 24h override so the chart still renders
      // something instead of an empty pane.
      if (range === "30d") {
        return seriesOverride30d ?? panelLazy30d ?? seriesOverride;
      }
      if (range === "7d") {
        return seriesOverride7d ?? panelLazy7d ?? seriesOverride;
      }
      // 90d / 1y: use Prom-backed lazy series when available, otherwise
      // return undefined so pickBenchValues falls through to longRangeSeries
      // (archive). An empty map would hide the archive lines.
      // 180d / all: no Prom panel data; fall through to longRangeSeries.
      if (range === "90d") {
        if (panelLazy90d && Object.keys(panelLazy90d).length > 0) return panelLazy90d;
        return undefined;
      }
      if (range === "1y") {
        if (panelLazy1y && Object.keys(panelLazy1y).length > 0) return panelLazy1y;
        return undefined;
      }
      return undefined;
    };
    const panel = pickPanel();
    const sliceOverride = (full: (number | null)[]): (number | null)[] => {
      // Sub 24h ranges slice the 24h panel series trailing edge.
      if (range === "24h" || range === "7d" || range === "30d") return full;
      const ratio = RANGE_HOURS[range] / 24;
      const take = Math.max(2, Math.round(full.length * ratio));
      return full.slice(-take);
    };
    // Bench-level 7d / 30d series are lazy-loaded (see useEffect above).
    // Long-range series (90d / 180d / 1y / all) come from an external
    // map populated by the parent — typically by fetching the
    // long-window archive for the bench.
    // Pick from the lazy map when in those ranges, fall back to
    // pickSeries (which uses benchmark.extras.series24h) otherwise.
    const pickBenchValues = (slug: string): (number | null)[] => {
      if (isLongRange) {
        return longRangeSeries?.[range]?.[slug] ?? [];
      }
      if (range === "7d" && lazySeries7d) return lazySeries7d[slug] ?? [];
      if (range === "30d" && lazySeries30d) return lazySeries30d[slug] ?? [];
      return pickSeries(benchmark, slug, range, region);
    };
    const built = benchmark.results
      .map((r) => ({
        slug: r.slug,
        name: r.name,
        color: colors.get(r.slug) ?? "var(--color-ink-soft)",
        values: panel
          ? sliceOverride(panel[r.slug] ?? [])
          : pickBenchValues(r.slug),
        excluded: excluded.has(r.slug),
      }))
      .filter((l) => l.values.length > 0);

    // Respect higher_is_better when ranking lines. For a panel like
    // effective fee bps where lower means better, the Top N selector
    // should surface the BEST N (smallest values), matching the ledger
    // table below which sorts the same way. Without this the chart and
    // ledger would disagree on what Top 5 means.
    const higherIsBetter = higherIsBetterOverride ?? benchmark.higherIsBetter;
    built.sort((a, b) => {
      const av = mean(a.values.slice(-6));
      const bv = mean(b.values.slice(-6));
      return higherIsBetter ? bv - av : av - bv;
    });
    return built;
  }, [benchmark, range, region, colors, excluded, seriesOverride, seriesOverride7d, seriesOverride30d, higherIsBetterOverride, lazySeries7d, lazySeries30d, isLongRange, longRangeSeries, panelLazy90d, panelLazy1y]);

  // Top-N selector — sized off the post-filter line count via the
  // shared `useTopN` hook so the option set agrees across every
  // chart view on the bench page.
  const { topN, setTopN, topNOptions } = useTopN(allLines.length, { external: topNControl, disabled: disableTopN });
  const lines = useMemo(() => {
    if (topN == null) return allLines;
    return allLines.slice(0, topN);
  }, [allLines, topN]);

  // A key that flips when the data shape changes. used to retrigger
  // the line-draw animation.
  const seriesKey = `${range}::${region}::${metricLabelOverride ?? "default"}`;

  // Format the zoomed-window label so the header tells the reader
  // exactly which slice of the original range they're looking at, e.g.
  // "head lag · −18 h → −12 h (6 h window)". Falls back to the normal
  // range label when no zoom is active.
  const totalWindowH = RANGE_HOURS[range];
  const zoomLabel = zoom
    ? (() => {
        const startAgo = (1 - zoom.startFrac) * totalWindowH;
        const endAgo = (1 - zoom.endFrac) * totalWindowH;
        const spanH = startAgo - endAgo;
        const fmt = (h: number) =>
          h < 0.05
            ? "now"
            : h < 1
              ? `−${Math.round(h * 60)} min`
              : h < 48
                ? `−${h.toFixed(h < 6 ? 1 : 0)} h`
                : `−${(h / 24).toFixed(0)} d`;
        const span =
          spanH < 1
            ? `${Math.round(spanH * 60)} min`
            : spanH < 48
              ? `${spanH.toFixed(spanH < 6 ? 1 : 0)} h`
              : `${(spanH / 24).toFixed(0)} d`;
        return `${fmt(startAgo)} → ${fmt(endAgo)} (${span} window)`;
      })()
    : RANGE_LABEL[range];

  return (
    <figure className="my-2" ref={figureRef}>
      <div className="mb-3 flex items-center justify-between gap-3 min-h-7" data-chart-export-omit="true">
        <p className="inline-flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          <LiveDot />
          <span>
            {metricLabelOverride ?? benchmark.metric} · {zoomLabel}
          </span>
        </p>
        <div className="flex items-center gap-2">
          <ChartExportButton
            targetRef={chartBodyRef}
            filename={`openchainbench-${benchmark.slug}-${range}`}
          />
          {zoom && (
            <button
              type="button"
              onClick={() => setZoom(null)}
              className="inline-flex items-center gap-1.5 rounded-md border border-ink/15 bg-paper px-2.5 py-1 text-[11px] font-sans font-medium uppercase tracking-[0.1em] text-ink shadow-sm transition-all hover:border-ink/40 hover:shadow-md"
              aria-label="Reset chart zoom"
              title="Show the full range again"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 8a5 5 0 1 0 1.5-3.5" />
                <path d="M3 3v3h3" />
              </svg>
              Reset zoom
            </button>
          )}
          {headerActions}
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3" data-chart-export-omit="true">
        <div className="flex flex-wrap items-center gap-1">
          {RANGES.map((r) => {
            const active = r === range;
            const disabled =
              (r === "7d" && !has7d) || (r === "30d" && !has30d);
            return (
              <button
                key={r}
                type="button"
                onClick={() => !disabled && setRange(r)}
                disabled={disabled}
                className={[
                  "rounded px-2.5 py-1 text-[11px] font-sans tabular uppercase tracking-[0.1em] font-medium transition-colors",
                  active
                    ? "bg-ink text-paper"
                    : "text-ink-muted hover:text-ink hover:bg-paper-soft",
                  disabled ? "opacity-40 cursor-not-allowed" : "",
                ].join(" ")}
                title={
                  disabled
                    ? `${r} retention not available yet`
                    : undefined
                }
              >
                {r}
              </button>
            );
          })}
          {longRangeSeries && (
            <>
              {/* Hairline separator between live (Prom) and archive
                  ranges so the reader sees they come from a different
                  data source — kept inside the same pill strip so the
                  selection feels like one control. */}
              <span
                aria-hidden
                className="mx-1 inline-block h-4 w-px bg-rule"
              />
              {LONG_RANGES.map((r) => {
                const active = r === range;
                // Archive series covers all long-range windows (90d/180d/1y/all)
                // even when a panel is active — panelBlocks no longer needed.
                const panelBlocks = false;
                const disabled = longRangeDisabled || panelBlocks;
                const title = panelBlocks
                  ? "Switch to the main metric for 180D / ALL history"
                  : longRangeDisabled
                    ? (longRangeDisabledTitle ??
                      "Archive temporarily unavailable")
                    : undefined;
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => !disabled && setRange(r)}
                    disabled={disabled}
                    className={[
                      "rounded px-2.5 py-1 text-[11px] font-sans tabular uppercase tracking-[0.1em] font-medium transition-colors",
                      active
                        ? "bg-ink text-paper"
                        : disabled
                          ? "text-ink-faint cursor-not-allowed"
                          : "text-ink-muted hover:text-ink hover:bg-paper-soft",
                    ].join(" ")}
                    title={title}
                  >
                    {r}
                    {disabled && !panelBlocks && (
                      <span className="ml-1 text-[9px] text-ink-faint">soon</span>
                    )}
                  </button>
                );
              })}
            </>
          )}
        </div>

        {showRegionTabs && (
          <div className="flex items-center gap-1">
            <span className="mr-2 label-mono-xs">
              Region
            </span>
            <RegionTab
              slug="all"
              label="All"
              active={region === "all"}
              onClick={() => setRegion("all")}
            />
            {availableRegions.map((r) => (
              <RegionTab
                key={r}
                slug={r}
                label={REGION_LABEL[r] ?? r}
                active={region === r}
                onClick={() => setRegion(r)}
              />
            ))}
          </div>
        )}

        <TopNSelector value={topN} options={topNOptions} onChange={setTopN} />
      </div>

      <div ref={chartBodyRef}>
        {lines.length === 0 ? (
          <div className="border-y-2 border-ink py-12 text-center text-ink-muted text-sm">
            No time-series data emitted for this range yet.
          </div>
        ) : (
          <Chart
            key={seriesKey}
            lines={lines as LineWithColor[]}
            unit={unitOverride ?? benchmark.unit}
            windowHours={RANGE_HOURS[range]}
            expectedPoints={RANGE_EXPECTED_POINTS[range]}
            zoom={zoom}
            onZoom={setZoom}
            onToggleExclude={toggle}
            onResetExcluded={excluded.size > 0 ? reset : undefined}
          />
        )}
      </div>
    </figure>
  );
}

function RegionTab({
  slug,
  label,
  active,
  onClick,
}: {
  slug: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const accent = brandColor(slug);
  const activeStyle = active
    ? { background: accent ?? "var(--color-ink)", color: "var(--color-paper)" }
    : undefined;
  const className = active
    ? "rounded-md px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] shadow-sm transition-colors"
    : "rounded-md px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] border border-rule text-ink-muted hover:text-ink hover:bg-paper-soft transition-colors";
  return (
    <button type="button" onClick={onClick} style={activeStyle} className={className}>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-flex items-center justify-center rounded-full"
          style={{
            width: 14,
            height: 14,
            background: active ? "rgba(255,255,255,0.18)" : (accent ?? "var(--color-ink-soft)"),
            color: "var(--color-paper)",
          }}
        >
          <Globe size={9} strokeWidth={2.2} />
        </span>
        {label}
      </span>
    </button>
  );
}
