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
import { fmtUnit, unitSuffix, fmtValue } from "@/lib/format";
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
function variantKey(chain: string | null, region: string | null): string {
  return `${chain ?? "__none"}|${region ?? "__none"}`;
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
  initialChain,
  initialRegion,
}: {
  variants: Record<string, Benchmark>;
  chainOptions: ChainOption[];
  regionOptions: ChainOption[];
  initialChain: string | null;
  initialRegion: string | null;
}) {
  // Read ?chain= / ?region= client-side. The server can't read these any
  // more (doing so would force /benchmarks/<slug> to render dynamic on
  // every visit) so URL-driven filter state is hydrated here. Falls back
  // to the server-rendered initial when the URL has no filter or a
  // value that doesn't match the spec's dimensions.
  const searchParams = useSearchParams();
  const urlChain = searchParams.get("chain");
  const urlRegion = searchParams.get("region");
  const resolvedInitialChain =
    (urlChain && chainOptions.find((c) => c.value === urlChain)?.value) ?? initialChain;
  const resolvedInitialRegion =
    (urlRegion && regionOptions.find((r) => r.value === urlRegion)?.value) ?? initialRegion;

  const [chain, setChain] = useState<string | null>(resolvedInitialChain);
  const [region, setRegion] = useState<string | null>(resolvedInitialRegion);

  useEffect(() => {
    const url = new URL(window.location.href);
    syncParam(url, "chain", chain, chainOptions);
    syncParam(url, "region", region, regionOptions);
    const next = url.pathname + (url.search ? url.search : "");
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, "", next);
    }
  }, [chain, region, chainOptions, regionOptions]);

  const fallbackChain = chainOptions[0]?.value ?? null;
  const fallbackRegion = regionOptions[0]?.value ?? null;
  const effectiveChain = chainOptions.length > 0 ? (chain ?? fallbackChain) : null;
  const effectiveRegion = regionOptions.length > 0 ? (region ?? fallbackRegion) : null;
  const benchmark =
    variants[variantKey(effectiveChain, effectiveRegion)] ??
    variants[variantKey(null, null)] ??
    Object.values(variants)[0];
  if (!benchmark) return null;

  // L1/L2 filter counts, derived from the full unfiltered results so the
  // pill counts are stable as the user toggles the filter.
  const layerCounts = useMemo(() => {
    let l1 = 0;
    let l2 = 0;
    for (const r of benchmark.results) {
      if (r.layer === "l1") l1++;
      else if (r.layer === "l2") l2++;
    }
    return { all: benchmark.results.length, l1, l2 };
  }, [benchmark.results]);

  // When the bench mixes L1 and L2 chains we render two separate ledger
  // tables — one per layer — so the ranking inside each layer reads
  // cleanly. Mixing them in a single sort buries Avalanche between
  // Blast and Optimism, which is technically correct but unreadable for
  // wallet UX decisions ("what does it cost on L1 vs L2"). Keeping the
  // full unfiltered benchmark for the chart above.
  const hasLayerSplit = layerCounts.l1 > 0 && layerCounts.l2 > 0;
  const filterByLayer = (l: ProviderLayer) => ({
    ...benchmark,
    results: benchmark.results.filter((r) => r.layer === l),
  });
  const l1Benchmark = useMemo(() => filterByLayer("l1"), [benchmark]);
  const l2Benchmark = useMemo(() => filterByLayer("l2"), [benchmark]);

  const isDraft = benchmark.status === "draft";
  const { fieldMin, fieldMedian, fieldMax, tailMin, tailMax, tailSpread } =
    computeFieldStats(benchmark.results);

  // View switcher state. Per-bench, persisted via localStorage. Default
  // mirrors the heuristic the page used before the switcher existed so
  // an anonymous user with no prior preference sees the same layout
  // they always saw.
  const allowedViews = viewsForBenchmark(benchmark);
  const defaultView = defaultViewFor(benchmark);
  const [view, setView, viewMounted] = useViewPreference(
    benchmark.slug,
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
      {(chainOptions.length > 0 || regionOptions.length > 0) && (
        <div className="mt-8 space-y-3">
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
                    summarize(variants[variantKey(o.value, effectiveRegion)]),
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
                    summarize(variants[variantKey(effectiveChain, o.value)]),
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
        </div>
      )}

      {!isDraft && benchmark.unit !== "count" && (
        <dl className="mt-10 card rounded-xl grid grid-cols-2 sm:flex sm:flex-wrap divide-y divide-x sm:divide-y-0 divide-rule overflow-hidden">
          <SummaryStat
            label="Best"
            value={`${fmtValue(fieldMin, benchmark.unit)}${unitSuffix(benchmark.unit)}`}
          />
          <SummaryStat
            label="Median"
            value={`${fmtValue(fieldMedian, benchmark.unit)}${unitSuffix(benchmark.unit)}`}
          />
          <SummaryStat
            label="Worst"
            value={`${fmtValue(fieldMax, benchmark.unit)}${unitSuffix(benchmark.unit)}`}
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
      )}

      {!isDraft && (
        <>
          <div className="mt-8 card-soft rounded-xl p-4 sm:p-6 lg:p-8">
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
                  benchmark={benchmark}
                  headerActions={<ViewSwitcher allowed={allowedViews} value={view} onChange={setView} />}
                />
              )}
              {view === "rankedBar" && (
                <RankedBarChart
                  benchmark={benchmark}
                  excluded={excluded}
                  onToggleExclude={toggleExclude}
                  onResetExcluded={resetExcluded}
                  headerActions={<ViewSwitcher allowed={allowedViews} value={view} onChange={setView} />}
                />
              )}
              {view === "distribution" && (
                <DistributionChart
                  benchmark={benchmark}
                  excluded={excluded}
                  onToggleExclude={toggleExclude}
                  onResetExcluded={resetExcluded}
                  headerActions={<ViewSwitcher allowed={allowedViews} value={view} onChange={setView} />}
                />
              )}
              {view === "donut" && (
                <DonutChart
                  benchmark={benchmark}
                  excluded={excluded}
                  onToggleExclude={toggleExclude}
                  headerActions={<ViewSwitcher allowed={allowedViews} value={view} onChange={setView} />}
                />
              )}
              {view === "timeseries" && (
                <>
                  {benchmark.metricPanels && benchmark.metricPanels.length > 0 && (
                    <MetricViewTabs
                      panels={benchmark.metricPanels}
                      mainLabel={benchmark.metric}
                      activeId={activePanelId}
                      onSelect={setActivePanelId}
                    />
                  )}
                  <TimeSeriesChart
                    benchmark={benchmark}
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
                    headerActions={<ViewSwitcher allowed={allowedViews} value={view} onChange={setView} />}
                    seriesOverride={activePanel?.seriesByProvider}
                    metricLabelOverride={activePanel?.label}
                    unitOverride={activePanel?.unit}
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

          {hasLayerSplit ? (
            <>
              <div className="mt-8 card-soft rounded-xl p-4 sm:p-6 lg:p-8">
                <p className="label-mono text-ink-faint mb-4">
                  Layer 1 · {layerCounts.l1} chains · sorted by p50
                </p>
                <LedgerTable benchmark={l1Benchmark} activePanel={activePanel} />
              </div>
              <div className="mt-8 card-soft rounded-xl p-4 sm:p-6 lg:p-8">
                <p className="label-mono text-ink-faint mb-4">
                  Layer 2 · {layerCounts.l2} chains · sorted by p50
                </p>
                <LedgerTable benchmark={l2Benchmark} activePanel={activePanel} />
              </div>
            </>
          ) : (
            <div className="mt-8 card-soft rounded-xl p-4 sm:p-6 lg:p-8">
              <p className="label-mono text-ink-faint mb-4">
                {benchmark.unit === "count"
                  ? "Product ledger"
                  : activePanel
                    ? `Product ledger · sorted by ${activePanel.label}`
                    : "Product ledger · sorted by p50"}
              </p>
              <LedgerTable benchmark={benchmark} activePanel={activePanel} />
            </div>
          )}

          {benchmark.unit !== "count" &&
            Object.keys(benchmark.extras.regions).length > 0 && (
              <div className="mt-8 card-soft rounded-xl p-4 sm:p-6 lg:p-8">
                <p className="label-mono text-ink-faint mb-4">By region</p>
                <RegionGrid benchmark={benchmark} />
              </div>
            )}
        </>
      )}
    </>
  );
}
