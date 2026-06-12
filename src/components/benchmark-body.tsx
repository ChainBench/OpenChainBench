"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Benchmark } from "@/types/benchmark";
import { liveResults } from "@/lib/provider-filters";
import { ChainTabs } from "@/components/chain-tabs";
import { LedgerTable } from "@/components/ledger-table";
import { TimeSeriesChart } from "@/components/time-series-chart";
import { RankedBarChart } from "@/components/ranked-bar-chart";
import { DistributionChart } from "@/components/distribution-chart";
import { DonutChart } from "@/components/donut-chart";
import { RegionGrid } from "@/components/region-grid";
import { MetricViewTabs } from "@/components/metric-view-tabs";
import type { ProviderLayer } from "@/types/benchmark";
import { CountLeaderboard } from "@/components/count-leaderboard";
import { SummaryStat } from "@/components/summary-stat";
import { ViewSwitcher } from "@/components/view-switcher";
import { fmtUnit } from "@/lib/format";
import { computeFieldStats } from "@/lib/stats";
import { defaultViewFor, viewsForBenchmark } from "@/lib/views";
import { useViewPreference } from "@/hooks/use-view-preference";
import type { ChainMeta } from "@/components/chain-tabs";

type ChainOption = { value: string; label: string };

/** One labelled row of dimension tabs (Chain, Region, …). Reuses the
 *  existing ChainTabs visual so we keep one design vocabulary for filters. */
function DimensionRow({
  label,
  options,
  selected,
  onSelect,
  metaByValue,
}: {
  label: string;
  options: ChainOption[];
  selected: string | null;
  onSelect: (v: string) => void;
  metaByValue?: Record<string, ChainMeta>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="font-sans text-[10px] uppercase tracking-[0.18em] text-ink-faint shrink-0 w-14 font-medium">
        {label}
      </span>
      <ChainTabs
        options={options}
        selected={selected}
        onSelect={onSelect}
        meta={metaByValue}
      />
    </div>
  );
}

/** Mutate `url.searchParams` to keep one dimension param in sync.
 *  Removes the param when the value is the first option (the implicit
 *  default) so canonical URLs stay short. */
function syncParam(
  url: URL,
  key: string,
  value: string | null,
  options: ChainOption[],
) {
  const fallback = options[0]?.value ?? null;
  if (!options.length || !value || value === fallback) {
    url.searchParams.delete(key);
  } else {
    url.searchParams.set(key, value);
  }
}

function summarize(b: Benchmark | undefined): ChainMeta | null {
  if (!b) return null;
  const live = liveResults(b.results);
  if (live.length === 0) return { providers: 0, metric: b.metric };
  const sorted = [...live].sort((a, c) =>
    b.higherIsBetter ? c.ms.p50 - a.ms.p50 : a.ms.p50 - c.ms.p50
  );
  return {
    providers: live.length,
    metric: b.metric,
    leader: {
      name: sorted[0].name,
      value: fmtUnit(sorted[0].ms.p50, b.unit),
    },
  };
}

/**
 * Client wrapper that renders the dynamic body of a bench detail page.
 * Receives every chain variant pre-fetched server-side, so flipping a
 * chain tab is a pure client state swap. No network round-trip, no RSC
 * payload, no Prom round-trip - instant.
 *
 * URL is kept in sync via `history.replaceState` so the active tab is
 * shareable, but we never trigger Next.js navigation (which would defeat
 * the whole point).
 */
/** Stable variant-map key mirroring `page.tsx:variantKey`. */
function variantKey(
  chain: string | null,
  region: string | null,
  kind: string | null,
): string {
  return `${chain ?? "__none"}|${region ?? "__none"}|${kind ?? "__none"}`;
}

/** Region values that appear in extras.seriesByRegion24h. Used when the
 *  spec doesn't declare `dimensions.region` but the chart still has
 *  per-region series - so we can offer the same picker affordance at the
 *  top of the page next to Chain rather than buried in the chart toolbar. */
function chartOnlyRegions(b: Benchmark): string[] {
  const byRegion = b.extras.seriesByRegion24h ?? {};
  const set = new Set<string>();
  for (const slug of Object.keys(byRegion)) {
    for (const r of Object.keys(byRegion[slug])) set.add(r);
  }
  return Array.from(set).sort();
}

const REGION_DISPLAY: Record<string, string> = {
  "us-east": "US-East",
  "eu-west": "EU-West",
  "ap-southeast": "AP-Southeast",
  global: "Global",
};

export function BenchmarkBody({
  variants,
  chainOptions,
  regionOptions,
  kindOptions = [],
  initialChain,
  initialRegion,
  initialKind = null,
}: {
  variants: Record<string, Benchmark>;
  chainOptions: ChainOption[];
  regionOptions: ChainOption[];
  kindOptions?: ChainOption[];
  initialChain: string | null;
  initialRegion: string | null;
  initialKind?: string | null;
}) {
  // Read ?chain= / ?region= / ?kind= client-side. The server can't read these any
  // more (doing so would force /benchmarks/<slug> to render dynamic on
  // every visit) so URL-driven filter state is hydrated here. Falls back
  // to the server-rendered initial when the URL has no filter or a
  // value that doesn't match the spec's dimensions.
  const searchParams = useSearchParams();
  const urlChain = searchParams.get("chain");
  const urlRegion = searchParams.get("region");
  const urlKind = searchParams.get("kind");
  const urlLayer = searchParams.get("layer");
  const resolvedInitialChain =
    (urlChain && chainOptions.find((c) => c.value === urlChain)?.value) ?? initialChain;
  const resolvedInitialRegion =
    (urlRegion && regionOptions.find((r) => r.value === urlRegion)?.value) ?? initialRegion;
  const resolvedInitialKind =
    (urlKind && kindOptions.find((k) => k.value === urlKind)?.value) ?? initialKind;
  const resolvedInitialLayer: ProviderLayer =
    urlLayer === "l2" ? "l2" : "l1";

  const [chain, setChain] = useState<string | null>(resolvedInitialChain);
  const [region, setRegion] = useState<string | null>(resolvedInitialRegion);
  const [kind, setKind] = useState<string | null>(resolvedInitialKind);
  const [layer, setLayer] = useState<ProviderLayer>(resolvedInitialLayer);

  useEffect(() => {
    const url = new URL(window.location.href);
    syncParam(url, "chain", chain, chainOptions);
    syncParam(url, "region", region, regionOptions);
    syncParam(url, "kind", kind, kindOptions);
    // Layer param: drop when default ("l1"), keep when user picked l2.
    if (layer === "l1") url.searchParams.delete("layer");
    else url.searchParams.set("layer", layer);
    const next = url.pathname + (url.search ? url.search : "");
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, "", next);
    }
  }, [chain, region, kind, layer, chainOptions, regionOptions, kindOptions]);

  const fallbackChain = chainOptions[0]?.value ?? null;
  const fallbackRegion = regionOptions[0]?.value ?? null;
  const fallbackKind = kindOptions[0]?.value ?? null;
  const effectiveChain = chainOptions.length > 0 ? (chain ?? fallbackChain) : null;
  const effectiveRegion = regionOptions.length > 0 ? (region ?? fallbackRegion) : null;
  const effectiveKind = kindOptions.length > 0 ? (kind ?? fallbackKind) : null;

  // The page ships ONLY the aggregate view (embedding every variant made
  // ISR regenerations take 30-60 s). Filtered variants are fetched here
  // on demand; while one loads, the aggregate keeps rendering so the tab
  // flip never blanks the page. Failed fetches keep the aggregate (the
  // tab still works, numbers stay cross-dimension) and may retry on the
  // next flip.
  const [variantMap, setVariantMap] = useState<Record<string, Benchmark>>(variants);
  const activeKey = variantKey(effectiveChain, effectiveRegion, effectiveKind);
  const aggregateBench =
    variants[variantKey(null, null, null)] ?? Object.values(variants)[0];
  useEffect(() => {
    if (variantMap[activeKey] || !aggregateBench) return;
    const isAll = (v: string | null) => !v || v === "all";
    if (isAll(effectiveChain) && isAll(effectiveRegion) && isAll(effectiveKind)) {
      setVariantMap((m) => ({ ...m, [activeKey]: aggregateBench }));
      return;
    }
    const qs = new URLSearchParams();
    if (!isAll(effectiveChain)) qs.set("chain", effectiveChain!);
    if (!isAll(effectiveRegion)) qs.set("region", effectiveRegion!);
    if (!isAll(effectiveKind)) qs.set("kind", effectiveKind!);
    let cancelled = false;
    fetch(`/api/bench/${aggregateBench.slug}/variant?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((v: Benchmark | null) => {
        if (!cancelled && v) setVariantMap((m) => ({ ...m, [activeKey]: v }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  // Background prefetch of the adjacent variants: every chain at the
  // current region/kind plus every region at the current chain. The
  // first fetch of a combo costs 1-7s server-side (function cold start
  // + first render), which the user otherwise eats as a long dimmed
  // state after clicking a tab. Warming them right after mount turns
  // tab flips into in-memory swaps. Staggered 400ms apart to stay
  // gentle; the variant API dedupes across users via its 60s cache,
  // and re-runs when the user settles on a new axis value so the
  // cross-axis re-warms.
  useEffect(() => {
    if (!aggregateBench) return;
    const isAll = (v: string | null) => !v || v === "all";
    const combos: [string | null, string | null, string | null][] = [
      ...chainOptions.map(
        (c) => [c.value, effectiveRegion, effectiveKind] as [string | null, string | null, string | null],
      ),
      ...regionOptions.map(
        (r) => [effectiveChain, r.value, effectiveKind] as [string | null, string | null, string | null],
      ),
    ];
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let i = 0;
    for (const [c, r, k] of combos) {
      if (isAll(c) && isAll(r) && isAll(k)) continue;
      const key = variantKey(c, r, k);
      if (variantMap[key]) continue;
      const qs = new URLSearchParams();
      if (!isAll(c)) qs.set("chain", c!);
      if (!isAll(r)) qs.set("region", r!);
      if (!isAll(k)) qs.set("kind", k!);
      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          fetch(`/api/bench/${aggregateBench.slug}/variant?${qs.toString()}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((v: Benchmark | null) => {
              if (!cancelled && v) {
                setVariantMap((m) => (m[key] ? m : { ...m, [key]: v }));
              }
            })
            .catch(() => {});
        }, 400 * i++),
      );
    }
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
    // variantMap intentionally omitted: presence is re-checked inside the
    // functional setState, a duplicate in-flight fetch is harmless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveChain, effectiveRegion, effectiveKind, aggregateBench]);

  const benchmark = variantMap[activeKey] ?? aggregateBench;
  if (!benchmark) return null;
  // True while the selected chain/region/kind variant is still loading:
  // the page shows the aggregate as a placeholder, which without a
  // visible signal reads as "the filter does nothing" (cold variant
  // fetches take 5-15s+). Dim the data sections and say so.
  const variantPending = !variantMap[activeKey];
  const pendingCls = variantPending
    ? " opacity-40 animate-pulse pointer-events-none"
    : "";
  const pendingLabel = [effectiveChain, effectiveRegion, effectiveKind]
    .filter((v): v is string => !!v && v !== "all")
    .join(" · ");

  // L1/L2 layer counts. When both > 0 the bench mixes L1 and L2 chains
  // and we render a top-level Layer toggle that filters the entire page
  // (chart + summary + ledger) to one layer at a time. Default is L1.
  const layerCounts = useMemo(() => {
    let l1 = 0;
    let l2 = 0;
    for (const r of benchmark.results) {
      if (r.layer === "l1") l1++;
      else if (r.layer === "l2") l2++;
    }
    return { all: benchmark.results.length, l1, l2 };
  }, [benchmark.results]);
  const hasLayerSplit = layerCounts.l1 > 0 && layerCounts.l2 > 0;

  // Filter the benchmark to the active layer for the entire page. When
  // hasLayerSplit is false the original benchmark is returned untouched
  // so non-layer benches keep their existing behavior. The chart, the
  // summary stats and the ledger all read from `viewBenchmark`.
  const viewBenchmark = useMemo(() => {
    if (!hasLayerSplit) return benchmark;
    return {
      ...benchmark,
      results: benchmark.results.filter((r) => r.layer === layer),
    };
  }, [benchmark, hasLayerSplit, layer]);

  const isDraft = viewBenchmark.status === "draft";
  const { fieldMin, fieldMedian, fieldMax, tailMin, tailMax, tailSpread } =
    computeFieldStats(viewBenchmark.results);

  // View switcher state. Per-bench, persisted via localStorage. Default
  // mirrors the heuristic the page used before the switcher existed so
  // an anonymous user with no prior preference sees the same layout
  // they always saw.
  const allowedViews = viewsForBenchmark(viewBenchmark);
  const defaultView = defaultViewFor(viewBenchmark);
  const [view, setView, viewMounted] = useViewPreference(
    viewBenchmark.slug,
    defaultView,
    allowedViews,
  );

  // Shared exclusion set across every chart view on this page. A reader
  // who hides a provider on the ranked-bar view sees the same provider
  // hidden when they switch to distribution or donut - the model is
  // "this is the field of providers the reader chose to focus on",
  // not "what each view chose to drop". Resets on bench navigation.
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const toggleExclude = (slug: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  const resetExcluded = () => setExcluded(new Set());

  // Region tabs derived from chart-only per-region series data when the spec
  // doesn't declare `dimensions.region`. Keeping the affordance at the top
  // alongside Chain so both filters live in one visual block instead of
  // being split between the dimension row and the chart toolbar.
  const chartRegions = chartOnlyRegions(benchmark);
  const showChartRegionRow = regionOptions.length === 0 && chartRegions.length > 1;
  const [chartRegion, setChartRegion] = useState<string>("all");

  // Active companion-metric panel. null = main spec metric (default chart
  // data, default unit, default header). When a panel id is set, the chart
  // pulls its per-provider series from panel.seriesByProvider, swaps the
  // header label to panel.label, and the Y-axis unit to panel.unit.
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  // Single Top-N value shared across every chart view AND the ledger
  // so a reader who picks "Top 5" sees the same 5 providers in every
  // surface. Each chart still computes its own option set off its own
  // post-filter cohort, but the active value is parent-controlled.
  const [topN, setTopN] = useState<number | null>(null);
  const topNControl = useMemo(() => ({ topN, setTopN }), [topN]);
  const activePanel =
    benchmark.metricPanels?.find((p) => p.id === activePanelId) ?? null;
  const chartRegionOptions: ChainOption[] = useMemo(
    () => [
      { value: "all", label: "All" },
      ...chartRegions.map((r) => ({ value: r, label: REGION_DISPLAY[r] ?? r })),
    ],
    [chartRegions],
  );

  return (
    <>
      {(hasLayerSplit ||
        chainOptions.length > 0 ||
        regionOptions.length > 0 ||
        kindOptions.length > 0) && (
        <div className="mt-8 space-y-3">
          {hasLayerSplit && (
            <DimensionRow
              label="Layer"
              options={[
                { value: "l1", label: `L1 · ${layerCounts.l1}` },
                { value: "l2", label: `L2 · ${layerCounts.l2}` },
              ]}
              selected={layer}
              onSelect={(v) => setLayer(v as ProviderLayer)}
            />
          )}
          {kindOptions.length > 0 && (
            <DimensionRow
              label="Kind"
              options={kindOptions}
              selected={kind ?? fallbackKind}
              onSelect={setKind}
              metaByValue={Object.fromEntries(
                kindOptions
                  .map((o) => [
                    o.value,
                    summarize(
                      variantMap[variantKey(effectiveChain, effectiveRegion, o.value)],
                    ),
                  ])
                  .filter(([, v]) => v !== null) as [string, ChainMeta][]
              )}
            />
          )}
          {chainOptions.length > 0 && (
            <DimensionRow
              label="Chain"
              options={chainOptions}
              selected={chain ?? fallbackChain}
              onSelect={setChain}
              metaByValue={Object.fromEntries(
                chainOptions
                  .map((o) => [
                    o.value,
                    summarize(variantMap[variantKey(o.value, effectiveRegion, effectiveKind)]),
                  ])
                  .filter(([, v]) => v !== null) as [string, ChainMeta][]
              )}
            />
          )}
          {regionOptions.length > 0 && (
            <DimensionRow
              label="Region"
              options={regionOptions}
              selected={region ?? fallbackRegion}
              onSelect={setRegion}
              metaByValue={Object.fromEntries(
                regionOptions
                  .map((o) => [
                    o.value,
                    summarize(variantMap[variantKey(effectiveChain, o.value, effectiveKind)]),
                  ])
                  .filter(([, v]) => v !== null) as [string, ChainMeta][]
              )}
            />
          )}
          {showChartRegionRow && (
            <DimensionRow
              label="Region"
              options={chartRegionOptions}
              selected={chartRegion}
              onSelect={setChartRegion}
            />
          )}
          {variantPending && (
            <div className="flex items-center gap-2 text-[12px] text-ink-muted" role="status">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Loading {pendingLabel || "filtered"} data, showing the
              all-chains aggregate meanwhile
            </div>
          )}
        </div>
      )}

      {!isDraft && benchmark.unit !== "count" && (() => {
        // For higher-is-better benches (e.g. HL frontends USD revenue), the
        // "best" headline is the max value, not the min. Latency benches keep
        // the original min=best mapping.
        const higherIsBetter = benchmark.higherIsBetter === true;
        const bestValue = higherIsBetter ? fieldMax : fieldMin;
        const worstValue = higherIsBetter ? fieldMin : fieldMax;
        return (
          <dl className={"mt-10 card rounded-xl grid grid-cols-2 sm:flex sm:flex-wrap divide-y divide-x sm:divide-y-0 divide-rule overflow-hidden" + pendingCls}>
            <SummaryStat
              label="Best"
              value={fmtUnit(bestValue, benchmark.unit)}
            />
            <SummaryStat
              label="Median"
              value={fmtUnit(fieldMedian, benchmark.unit)}
            />
            <SummaryStat
              label="Worst"
              value={fmtUnit(worstValue, benchmark.unit)}
            />
            <SummaryStat
              label="Spread"
              value={tailSpread > 0 ? `${tailSpread.toFixed(1)}×` : "-"}
              hint={
                tailSpread > 0
                  ? `${fmtUnit(tailMin, benchmark.unit)} → ${fmtUnit(tailMax, benchmark.unit)}`
                  : undefined
              }
            />
          </dl>
        );
      })()}

      {!isDraft && (
        <>
          <div className={"mt-8 card-soft rounded-xl p-4 sm:p-6 lg:p-8" + pendingCls}>
            {/* Each chart owns its header row and accepts a headerActions
                slot. We pass the ViewSwitcher there so the control sits
                on the same baseline as the chart's own title text -
                consistent across all views, no separate row reserved,
                no absolute overlay that risks clipping the legend or
                action buttons each chart already has on the right. */}
            <div
              className="min-h-[260px] transition-opacity duration-200"
              style={{ opacity: viewMounted ? 1 : 0 }}
            >
              {view === "countLeaderboard" && (
                <CountLeaderboard
                  benchmark={viewBenchmark}
                  headerActions={<ViewSwitcher allowed={allowedViews} value={view} onChange={setView} />}
                />
              )}
              {view === "rankedBar" && (
                <RankedBarChart
                  benchmark={viewBenchmark}
                  excluded={excluded}
                  onToggleExclude={toggleExclude}
                  onResetExcluded={resetExcluded}
                  disableTopN={hasLayerSplit}
                  topNControl={topNControl}
                  headerActions={<ViewSwitcher allowed={allowedViews} value={view} onChange={setView} />}
                />
              )}
              {view === "distribution" && (
                <DistributionChart
                  benchmark={viewBenchmark}
                  excluded={excluded}
                  onToggleExclude={toggleExclude}
                  onResetExcluded={resetExcluded}
                  disableTopN={hasLayerSplit}
                  topNControl={topNControl}
                  headerActions={<ViewSwitcher allowed={allowedViews} value={view} onChange={setView} />}
                />
              )}
              {view === "donut" && (
                <DonutChart
                  benchmark={viewBenchmark}
                  excluded={excluded}
                  onToggleExclude={toggleExclude}
                  disableTopN={hasLayerSplit}
                  topNControl={topNControl}
                  headerActions={<ViewSwitcher allowed={allowedViews} value={view} onChange={setView} />}
                />
              )}
              {view === "timeseries" && (
                <>
                  {(() => {
                    const tabPanels = (benchmark.metricPanels ?? []).filter(
                      (p) => p.tab !== false,
                    );
                    return tabPanels.length > 0 ? (
                      <MetricViewTabs
                        panels={tabPanels}
                        mainLabel={benchmark.metric}
                        activeId={activePanelId}
                        onSelect={setActivePanelId}
                      />
                    ) : null;
                  })()}
                  <TimeSeriesChart
                    benchmark={viewBenchmark}
                    region={
                      regionOptions.length > 0
                        ? (region ?? fallbackRegion ?? undefined)
                        : showChartRegionRow
                          ? chartRegion
                          : undefined
                    }
                    excluded={excluded}
                    onToggleExclude={toggleExclude}
                    onResetExcluded={resetExcluded}
                    disableTopN={hasLayerSplit}
                  topNControl={topNControl}
                    headerActions={<ViewSwitcher allowed={allowedViews} value={view} onChange={setView} />}
                    seriesOverride={activePanel?.seriesByProvider}
                    seriesOverride7d={activePanel?.seriesByProvider7d}
                    seriesOverride30d={activePanel?.seriesByProvider30d}
                    metricLabelOverride={activePanel?.label}
                    unitOverride={activePanel?.unit}
                    higherIsBetterOverride={activePanel?.higherIsBetter}
                  />
                  {activePanel?.description && (
                    <p className="mt-3 text-[12px] text-ink-muted max-w-2xl">
                      {activePanel.description}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          <div className={"mt-8 card-soft rounded-xl p-4 sm:p-6 lg:p-8" + pendingCls}>
            <p className="label-mono text-ink-faint mb-4">
              {viewBenchmark.unit === "count"
                ? "Product ledger"
                : activePanel
                  ? `Product ledger · sorted by ${activePanel.label}`
                  : viewBenchmark.ledgerColumns?.length
                    ? `Product ledger · sorted by ${viewBenchmark.ledgerColumns[0].label}`
                    : "Product ledger · sorted by p50"}
            </p>
            <LedgerTable benchmark={viewBenchmark} activePanel={activePanel} topN={topN} />
          </div>

          {viewBenchmark.unit !== "count" &&
            Object.keys(benchmark.extras.regions).length > 0 && (
              <div className={"mt-8 card-soft rounded-xl p-4 sm:p-6 lg:p-8" + pendingCls}>
                <p className="label-mono text-ink-faint mb-4">By region</p>
                <RegionGrid benchmark={viewBenchmark} />
              </div>
            )}
        </>
      )}
    </>
  );
}
