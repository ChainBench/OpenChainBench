"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Benchmark } from "@/types/benchmark";
import { liveResults } from "@/lib/provider-filters";
import { matchesChainSlug } from "@/lib/chain-aliases";
import { ChainTabs } from "@/components/chain-tabs";
import { LedgerTable } from "@/components/ledger-table";
import { HlArchiveLeaderboard } from "@/components/hl-archive-leaderboard";
import { TimeSeriesChart } from "@/components/time-series-chart";
import type { Range as ChartRange } from "@/components/time-series-chart/scales";
import { LONG_RANGES } from "@/components/time-series-chart/scales";
import type {
  HlArchiveHistoryResponse,
  HlArchiveLongWindow,
} from "@/types/hl-archive";
import { RankedBarChart } from "@/components/ranked-bar-chart";
import { DistributionChart } from "@/components/distribution-chart";
import { DonutChart } from "@/components/donut-chart";
import { RegionGrid } from "@/components/region-grid";
import { MetricViewTabs } from "@/components/metric-view-tabs";
import type { ProviderLayer } from "@/types/benchmark";
import { CountLeaderboard } from "@/components/count-leaderboard";
import { SummaryStat } from "@/components/summary-stat";
import { ViewSwitcher } from "@/components/view-switcher";
import { fmtAsOfUtc, fmtUnit } from "@/lib/format";
import { computeFieldStats } from "@/lib/stats";
import { defaultViewFor, viewsForBenchmark } from "@/lib/views";
import { useViewPreference } from "@/hooks/use-view-preference";
import type { ChainMeta } from "@/components/chain-tabs";
import { FileText, Check } from "lucide-react";
import { Hint } from "@/components/hint";
import { StackedShareChart } from "@/components/stacked-share-chart";

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
  venue: string | null = null,
  tier: string | null = null,
): string {
  return `${chain ?? "__none"}|${region ?? "__none"}|${kind ?? "__none"}|${venue ?? "__none"}|${tier ?? "__none"}`;
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
  "us-west": "US-West",
  "eu-west": "EU-West",
  "ap-southeast": "AP-Southeast",
  global: "Global",
};

const RANGE_CFG: Record<string, { nPoints: number; hours: number; label: string }> = {
  "1h": { nPoints: 3, hours: 1, label: "1 h" },
  "6h": { nPoints: 18, hours: 6, label: "6 h" },
  "24h": { nPoints: 72, hours: 24, label: "24 h" },
  "7d": { nPoints: 84, hours: 168, label: "7 d" },
  "30d": { nPoints: 60, hours: 720, label: "30 d" },
};

function CsvButton({ benchmark, range }: { benchmark: Benchmark; range: string }) {
  const [done, setDone] = useState(false);
  const cfg = RANGE_CFG[range] ?? RANGE_CFG["24h"];
  const series =
    (range === "7d" ? benchmark.extras.series7d : undefined) ??
    (range === "30d" ? benchmark.extras.series30d : undefined) ??
    benchmark.extras.series24h;

  const onClick = useCallback(() => {
    if (!series || Object.keys(series).length === 0) return;
    const slugs = benchmark.results.map((r) => r.slug);
    const stepMs = (cfg.hours * 3_600_000) / cfg.nPoints;
    const now = Date.now();
    const header = ["timestamp", ...slugs].join(",");
    const rows = Array.from({ length: cfg.nPoints }, (_, i) => {
      const ts = new Date(now - cfg.hours * 3_600_000 + (i + 1) * stepMs).toISOString();
      return [ts, ...slugs.map((s) => { const v = series[s]?.[i]; return v == null ? "" : String(v); })].join(",");
    });
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `openchainbench-${benchmark.slug}-${range}.csv`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setDone(true);
    setTimeout(() => setDone(false), 1600);
  }, [benchmark, series, cfg, range]);

  if (!series || Object.keys(series).length === 0) return null;
  return (
    <Hint label={`Download CSV (${cfg.label})`}>
      <button
        type="button"
        onClick={onClick}
        aria-label="Download CSV"
        className="inline-flex items-center justify-center rounded-md border border-ink/15 bg-paper p-1.5 text-ink shadow-sm transition-colors hover:bg-paper-soft"
      >
        {done ? <Check size={13} strokeWidth={2.4} /> : <FileText size={13} strokeWidth={2} />}
      </button>
    </Hint>
  );
}

export function BenchmarkBody({
  variants,
  chainOptions,
  regionOptions,
  kindOptions = [],
  venueOptions = [],
  tierOptions = [],
  venuesForChain,
  initialChain,
  initialRegion,
  initialKind = null,
  initialVenue = null,
  initialTier = null,
  hasLongHistory = false,
  pageActions,
  headlineCohortBlock,
}: {
  variants: Record<string, Benchmark>;
  chainOptions: ChainOption[];
  regionOptions: ChainOption[];
  kindOptions?: ChainOption[];
  venueOptions?: ChainOption[];
  /** Access tiers (public / keyed), headline cohort first. The first
   *  option is the aggregate itself: it never hits the variant API and
   *  never appears in the URL. Another tier rides in the URL fragment
   *  (`#tier=keyed`), not the query string: one document for crawlers,
   *  the Private tab for readers (product pages, the hub and the
   *  citations link that form; `?tier=keyed` is still accepted). */
  tierOptions?: ChainOption[];
  /** Per-chain venue availability map. When present, venue tabs are filtered
   *  to only show venues that have data for the currently selected chain. */
  venuesForChain?: Record<string, string[]>;
  initialChain: string | null;
  initialRegion: string | null;
  initialKind?: string | null;
  initialVenue?: string | null;
  initialTier?: string | null;
  /** When true, render the long-window archive toggle (24h..All time)
   *  below the main ledger. Only set on benches whose harness ships a
   *  long-window archive blob (currently: hyperliquid-frontends). */
  hasLongHistory?: boolean;
  /** Page-level toolbar (Image / Video / Report). Rendered inline in the
   *  chart's header row on the left of the ViewSwitcher so the sharing
   *  affordances sit visually next to the per-chart Copy / Download
   *  button instead of floating alone at the top of the page. */
  pageActions?: import("react").ReactNode;
  /** Server-rendered block that belongs to the headline cohort only
   *  (the public endpoint URLs of a chain RPC page). Rendered under the
   *  ledger and hidden while another tier (Private) is selected: keyed
   *  URLs are never listed, so the block would contradict the table. */
  headlineCohortBlock?: import("react").ReactNode;
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
  const urlVenue = searchParams.get("venue");
  const urlTier = searchParams.get("tier");
  const urlLayer = searchParams.get("layer");
  // Canonical-aware lookup: a URL with the new slug ("?chain=gram")
  // still selects the dimension whose YAML value is the legacy "ton".
  const resolvedInitialChain =
    (urlChain &&
      chainOptions.find((c) => matchesChainSlug(c.value, urlChain))?.value) ??
    initialChain;
  const resolvedInitialRegion =
    (urlRegion && regionOptions.find((r) => r.value === urlRegion)?.value) ?? initialRegion;
  const resolvedInitialKind =
    (urlKind && kindOptions.find((k) => k.value === urlKind)?.value) ?? initialKind;
  const resolvedInitialVenue =
    (urlVenue && venueOptions.find((v) => v.value === urlVenue)?.value) ?? initialVenue;
  const resolvedInitialTier =
    (urlTier && tierOptions.find((t) => t.value === urlTier)?.value) ?? initialTier;
  const resolvedInitialLayer: ProviderLayer =
    urlLayer === "l2" ? "l2" : "l1";

  const [chain, setChain] = useState<string | null>(resolvedInitialChain);
  const [region, setRegion] = useState<string | null>(resolvedInitialRegion);
  const [kind, setKind] = useState<string | null>(resolvedInitialKind);
  const [venue, setVenue] = useState<string | null>(resolvedInitialVenue);
  const [tier, setTier] = useState<string | null>(resolvedInitialTier);
  const [layer, setLayer] = useState<ProviderLayer>(resolvedInitialLayer);
  // `#tier=<t>` is invisible to the server and to useSearchParams: read
  // it once after mount.
  useEffect(() => {
    if (tierOptions.length === 0) return;
    const apply = () => {
      const m = /(?:^#|[#&])tier=([A-Za-z0-9_-]+)/.exec(window.location.hash);
      const fromHash = m ? tierOptions.find((t) => t.value === m[1])?.value : undefined;
      if (fromHash) setTier(fromHash);
    };
    apply();
    // Same-page links (the TL;DR's "Private tab") change the hash
    // without a remount.
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Active companion-metric panel. null = main spec metric (default chart
  // data, default unit, default header). When a panel id is set, the
  // chart pulls its per-provider series from panel.seriesByProvider,
  // swaps the header label to panel.label, and the Y-axis unit to
  // panel.unit. Hydrated from ?view=<id> so the share-card / video
  // exporters (which read window.location) can reproduce the reader's
  // current view; the URL-sync useEffect below writes the reverse trip.
  // Validity is checked against the initial variant map; a stale ?view=
  // (e.g. panel dropped from the spec between deploys) falls back to
  // null instead of pinning an invalid id.
  const urlView = searchParams.get("view");
  const [activePanelId, setActivePanelId] = useState<string | null>(() => {
    if (!urlView) return null;
    const seedPanels =
      Object.values(variants)[0]?.metricPanels ?? [];
    return seedPanels.some((p) => p.id === urlView) ? urlView : null;
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    syncParam(url, "chain", chain, chainOptions);
    syncParam(url, "region", region, regionOptions);
    syncParam(url, "kind", kind, kindOptions);
    syncParam(url, "venue", venue, venueOptions);
    // Tier travels in the fragment (see tierOptions above); a legacy
    // ?tier= in the address bar is folded into it.
    url.searchParams.delete("tier");
    const tierFragment =
      tierOptions.length > 0 && tier && tier !== tierOptions[0].value ? `tier=${tier}` : "";
    // Leave a plain anchor (#public-endpoints, #methodology) alone.
    if (tierFragment || /tier=/.test(url.hash)) url.hash = tierFragment;
    // Layer param: drop when default ("l1"), keep when user picked l2.
    if (layer === "l1") url.searchParams.delete("layer");
    else url.searchParams.set("layer", layer);
    // View param: metric-panel selection. null = main spec metric =
    // no param (canonical URL stays clean when no view has been picked).
    if (activePanelId) url.searchParams.set("view", activePanelId);
    else url.searchParams.delete("view");
    const next = url.pathname + (url.search ? url.search : "") + (url.hash ? url.hash : "");
    if (next !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.replaceState(null, "", next);
    }
  }, [chain, region, kind, venue, tier, layer, activePanelId, chainOptions, regionOptions, kindOptions, venueOptions, tierOptions]);

  const fallbackChain = chainOptions[0]?.value ?? null;
  const fallbackRegion = regionOptions[0]?.value ?? null;
  const fallbackKind = kindOptions[0]?.value ?? null;
  const fallbackVenue = venueOptions[0]?.value ?? null;
  // The headline tier is the aggregate: represented as null in the
  // variant key and absent from the variant query string.
  const headlineTier = tierOptions[0]?.value ?? null;
  const tierParam = (t: string | null): string | null =>
    t && t !== headlineTier ? t : null;
  const effectiveChain = chainOptions.length > 0 ? (chain ?? fallbackChain) : null;

  // Per-chain default view (spec chart.default_panel_by_chain). Applied
  // when the reader lands without ?view= and each time the chain tab
  // changes, so Solana on aggregator-head-lag opens on First to report
  // while Base keeps the head lag headline. A ?view= in the URL wins on
  // first paint; after that the chain tab drives it like a fresh visit.
  // The chart block is editorial and rides on whichever variant went
  // through overlayEditorial; a URL-seeded filtered variant may not carry
  // it, so look across every seeded variant rather than the first one.
  const chartConfig = Object.values(variants).find((v) => v.chart)?.chart;
  const defaultPanelByChain = chartConfig?.defaultPanelByChain;
  const hideHeadline = Boolean(
    effectiveChain && chartConfig?.hideHeadlineByChain?.includes(effectiveChain),
  );
  const urlViewPinned = useRef(Boolean(urlView));
  useEffect(() => {
    if (!defaultPanelByChain) return;
    if (urlViewPinned.current) {
      urlViewPinned.current = false;
      return;
    }
    const want = effectiveChain ? defaultPanelByChain[effectiveChain] ?? null : null;
    const seedPanels = Object.values(variants)[0]?.metricPanels ?? [];
    const valid = want && seedPanels.some((p) => p.id === want) ? want : null;
    setActivePanelId(valid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveChain]);
  const effectiveRegion = regionOptions.length > 0 ? (region ?? fallbackRegion) : null;
  const effectiveKind = kindOptions.length > 0 ? (kind ?? fallbackKind) : null;
  const effectiveVenue = venueOptions.length > 0 ? (venue ?? fallbackVenue) : null;
  const effectiveTier = tierOptions.length > 0 ? tierParam(tier ?? headlineTier) : null;

  // Cross-dimension filtering: hide venue tabs with no data for the active
  // chain, and hide chain tabs with no data for the active venue.
  // Venue tabs are never filtered by chain: the user picks a launchpad first,
  // then drills into a chain. The reverse (chain → hides venues) is confusing
  // because launchpad tabs disappear unexpectedly.
  const filteredVenueOptions = venueOptions;

  const chainsForVenue = useMemo(() => {
    if (!venuesForChain) return undefined;
    const out: Record<string, string[]> = {};
    for (const [c, venues] of Object.entries(venuesForChain)) {
      for (const v of venues) (out[v] ??= []).push(c);
    }
    return out;
  }, [venuesForChain]);

  const filteredChainOptions = useMemo(() => {
    if (!chainsForVenue || !effectiveVenue || effectiveVenue === "all") return chainOptions;
    const valid = chainsForVenue[effectiveVenue];
    if (!valid || valid.length === 0) return chainOptions;
    const validSet = new Set(valid);
    // Strip the "all" aggregate option when a specific venue is selected: mixing
    // chains is unfair (a Solana-only provider scores 0% on Base tokens).
    return chainOptions.filter((c) => c.value !== "all" && validSet.has(c.value));
  }, [chainOptions, chainsForVenue, effectiveVenue]);

  // The page ships ONLY the aggregate view (embedding every variant made
  // ISR regenerations take 30-60 s). Filtered variants are fetched here
  // on demand; while one loads, the aggregate keeps rendering so the tab
  // flip never blanks the page. Failed fetches keep the aggregate (the
  // tab still works, numbers stay cross-dimension) and may retry on the
  // next flip.
  const [variantMap, setVariantMap] = useState<Record<string, Benchmark>>(variants);
  const activeKey = variantKey(effectiveChain, effectiveRegion, effectiveKind, effectiveVenue, effectiveTier);
  const aggregateBench =
    variants[variantKey(null, null, null, null, null)] ?? Object.values(variants)[0];
  const isAllSelection =
    (!effectiveChain || effectiveChain === "all") &&
    (!effectiveRegion || effectiveRegion === "all") &&
    (!effectiveKind || effectiveKind === "all") &&
    (!effectiveVenue || effectiveVenue === "all") &&
    !effectiveTier;
  useEffect(() => {
    if (variantMap[activeKey] || !aggregateBench) return;
    // The all/all/all selection IS the aggregate: derived at render time,
    // nothing to fetch.
    if (isAllSelection) return;
    const isAll = (v: string | null) => !v || v === "all";
    const qs = new URLSearchParams();
    if (!isAll(effectiveChain)) qs.set("chain", effectiveChain!);
    if (!isAll(effectiveRegion)) qs.set("region", effectiveRegion!);
    if (!isAll(effectiveKind)) qs.set("kind", effectiveKind!);
    if (!isAll(effectiveVenue)) qs.set("venue", effectiveVenue!);
    if (effectiveTier) qs.set("tier", effectiveTier);
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
    type Combo = [string | null, string | null, string | null, string | null, string | null];
    const combos: Combo[] = [
      ...chainOptions.map((c) => [c.value, effectiveRegion, effectiveKind, effectiveVenue, effectiveTier] as Combo),
      ...regionOptions.map((r) => [effectiveChain, r.value, effectiveKind, effectiveVenue, effectiveTier] as Combo),
      ...venueOptions.map((v) => [effectiveChain, effectiveRegion, effectiveKind, v.value, effectiveTier] as Combo),
      ...tierOptions.map((t) => [effectiveChain, effectiveRegion, effectiveKind, effectiveVenue, tierParam(t.value)] as Combo),
    ];
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let i = 0;
    for (const [c, r, k, vn, t] of combos) {
      if (isAll(c) && isAll(r) && isAll(k) && isAll(vn) && !t) continue;
      const key = variantKey(c, r, k, vn, t);
      if (variantMap[key]) continue;
      const qs = new URLSearchParams();
      if (!isAll(c)) qs.set("chain", c!);
      if (!isAll(r)) qs.set("region", r!);
      if (!isAll(k)) qs.set("kind", k!);
      if (!isAll(vn)) qs.set("venue", vn!);
      if (t) qs.set("tier", t);
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
  }, [effectiveChain, effectiveRegion, effectiveKind, effectiveVenue, effectiveTier, aggregateBench]);

  const benchmark = variantMap[activeKey] ?? aggregateBench;
  // True while the selected chain/region/kind variant is still loading:
  // the page shows the aggregate as a placeholder, which without a
  // visible signal reads as "the filter does nothing" (cold variant
  // fetches take 5-15s+). Dim the data sections and say so. The
  // all/all/all selection renders the aggregate by definition, so it is
  // never pending.
  const variantPending = !variantMap[activeKey] && !isAllSelection;

  // L1/L2 layer counts. When both > 0 the bench mixes L1 and L2 chains
  // and we render a top-level Layer toggle that filters the entire page
  // (chart + summary + ledger) to one layer at a time. Default is L1.
  const layerCounts = useMemo(() => {
    let l1 = 0;
    let l2 = 0;
    const results = benchmark?.results ?? [];
    for (const r of results) {
      if (r.layer === "l1") l1++;
      else if (r.layer === "l2") l2++;
    }
    return { all: results.length, l1, l2 };
  }, [benchmark]);
  const hasLayerSplit = layerCounts.l1 > 0 && layerCounts.l2 > 0;

  // Filter the benchmark to the active layer for the entire page. When
  // hasLayerSplit is false the original benchmark is returned untouched
  // so non-layer benches keep their existing behavior. The chart, the
  // summary stats and the ledger all read from `viewBenchmark`.
  const viewBenchmark = useMemo(() => {
    if (!benchmark || !hasLayerSplit) return benchmark;
    return {
      ...benchmark,
      results: benchmark.results.filter((r) => r.layer === layer),
    };
  }, [benchmark, hasLayerSplit, layer]);

  const asOfUtc = benchmark ? fmtAsOfUtc(benchmark.lastRunAt) : null;

  // View switcher state. Per-bench, persisted via localStorage. Default
  // mirrors the heuristic the page used before the switcher existed so
  // an anonymous user with no prior preference sees the same layout
  // they always saw.
  const allowedViews = viewBenchmark ? viewsForBenchmark(viewBenchmark) : [];
  const defaultView = viewBenchmark ? defaultViewFor(viewBenchmark) : "timeseries";
  const [view, setView, viewMounted] = useViewPreference(
    viewBenchmark?.slug ?? "",
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
  const chartRegions = useMemo(
    () => (benchmark ? chartOnlyRegions(benchmark) : []),
    [benchmark],
  );
  const showChartRegionRow = regionOptions.length === 0 && chartRegions.length > 1;
  const [chartRegion, setChartRegion] = useState<string>("all");

  // activePanelId is declared earlier (before the URL-sync effect) so
  // ?view=<id> stays in lockstep with chain / region / kind / venue in
  // replaceState. See the initializer above.
  // Single Top-N value shared across every chart view AND the ledger
  // so a reader who picks "Top 5" sees the same 5 providers in every
  // surface. Each chart still computes its own option set off its own
  // post-filter cohort, but the active value is parent-controlled.
  const [topN, setTopN] = useState<number | null>(null);
  const topNControl = useMemo(() => ({ topN, setTopN }), [topN]);
  const chartRegionOptions: ChainOption[] = useMemo(
    () => [
      { value: "all", label: "All" },
      ...chartRegions.map((r) => ({ value: r, label: REGION_DISPLAY[r] ?? r })),
    ],
    [chartRegions],
  );

  // Unified chart range. Default to the chart's own default ("24h") so
  // short ranges keep the existing visual exactly. When the bench has
  // long-window archive history, this state is also passed to the
  // leaderboard below so chart pills + ledger source stay in sync.
  // A daily-cadence bench (spec `chart.default_range`) opens on its own
  // window instead; the chart hides the sub-day pills in that case.
  const [chartRange, setChartRange] = useState<ChartRange>(
    (benchmark.chart?.defaultRange as ChartRange | undefined) ?? "24h",
  );

  // Per-window cache of the long-window archive payload. Populated lazily
  // when the user clicks a 90d/180d/1y/all pill, and used both to feed
  // the chart's `longRangeSeries` map and to replace the ledger rows
  // with archive-sourced ranks. `error` entries stand in for "tried,
  // failed" so we don't refetch on every render — the disabled-pill UX
  // is driven off the first failure too.
  const [hlArchiveCache, setHlArchiveCache] = useState<
    Record<string, HlArchiveHistoryResponse | { error: string }>
  >({});
  const [hlArchiveDisabled, setHlArchiveDisabled] = useState(false);

  // The 4 long-range chart pills are a strict subset of the archive's
  // long-window enum, so we coerce once here and pass the narrower type
  // down to the archive fetch + leaderboard. Keeps the rest of the file
  // free of `as` casts at every consumer.
  const longRangeKey: HlArchiveLongWindow | null = (
    LONG_RANGES as readonly ChartRange[]
  ).includes(chartRange)
    ? (chartRange as HlArchiveLongWindow)
    : null;

  useEffect(() => {
    if (!hasLongHistory) return;
    if (!longRangeKey) return;
    if (hlArchiveCache[longRangeKey]) return;
    let cancelled = false;
    fetch(
      `/api/bench/hyperliquid-frontends/history?window=${encodeURIComponent(longRangeKey)}`,
      { cache: "no-store" },
    )
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | HlArchiveHistoryResponse
          | { error: string }
          | null;
        if (cancelled) return;
        if (!res.ok || !body) {
          const err =
            body && "error" in body ? body.error : `http_${res.status}`;
          setHlArchiveCache((c) => ({ ...c, [longRangeKey]: { error: err } }));
          setHlArchiveDisabled(true);
          // Auto-revert the chart range so the user sees data instead of
          // a dead frame. 30d is the longest live window.
          setChartRange("30d");
          return;
        }
        setHlArchiveCache((c) => ({ ...c, [longRangeKey]: body }));
      })
      .catch(() => {
        if (cancelled) return;
        setHlArchiveCache((c) => ({
          ...c,
          [longRangeKey]: { error: "network" },
        }));
        setHlArchiveDisabled(true);
        setChartRange("30d");
      });
    return () => {
      cancelled = true;
    };
  }, [hasLongHistory, longRangeKey, hlArchiveCache]);

  // Derive the chart's `longRangeSeries` prop from the archive cache.
  // The mapped field is chosen based on the active panel so that switching
  // to a users/volume/fees panel also updates the long-range chart Y-axis.
  const hlLongRangeSeries = useMemo(() => {
    if (!hasLongHistory) return undefined;
    // Pick the archive field that matches the active panel metric so the
    // chart shows the right series when a panel (users / volume / fees) is
    // selected and the Prom 90d/1y panel series isn't available.
    const field =
      activePanelId === "users" || activePanelId === "users_7d" || activePanelId === "users_30d"
        ? "users" as const
        : activePanelId === "volume" || activePanelId === "volume_7d" || activePanelId === "volume_30d"
          ? "vol" as const
          : "fees" as const;
    const map: Partial<Record<ChartRange, Record<string, number[]>>> = {};
    for (const w of LONG_RANGES) {
      const cached = hlArchiveCache[w];
      if (!cached || "error" in cached) continue;
      const ts = cached.timeseries_daily ?? {};
      const perBuilder: Record<string, number[]> = {};
      for (const [slug, days] of Object.entries(ts)) {
        perBuilder[slug] = days.map((d) =>
          field === "users" ? (d.users ?? 0) : field === "vol" ? d.vol : d.fees
        );
      }
      map[w] = perBuilder;
    }
    return map;
  }, [hasLongHistory, hlArchiveCache, activePanelId]);

  const hlActiveArchive: HlArchiveHistoryResponse | null = useMemo(() => {
    if (!hasLongHistory || !longRangeKey) return null;
    const cached = hlArchiveCache[longRangeKey];
    if (!cached || "error" in cached) return null;
    return cached;
  }, [hasLongHistory, longRangeKey, hlArchiveCache]);

  const hlArchiveLoading = !!(
    hasLongHistory &&
    longRangeKey &&
    !hlArchiveCache[longRangeKey]
  );

  // Value views (ranked bars) swap each provider's headline p50 for the
  // active panel's scalar so the size tabs work on the default chart,
  // not only on the timeseries view. Providers the panel has no value
  // for (book could not fill the tier) drop out of the ranking, which
  // is the skipped-not-extrapolated rule made visible.
  //
  // Kept ABOVE the `if (!benchmark || !viewBenchmark) return null` early
  // return so this useMemo is called on every render (rules-of-hooks).
  const activePanel =
    benchmark?.metricPanels?.find((p) => p.id === activePanelId) ?? null;
  const panelViewBenchmark = useMemo(() => {
    if (!viewBenchmark) return null;
    if (!activePanel) return viewBenchmark;
    const vals = activePanel.values ?? {};
    return {
      ...viewBenchmark,
      metric: activePanel.label,
      unit: activePanel.unit ?? viewBenchmark.unit,
      // A panel carries its own direction (First to report: higher is
      // better on a lower-is-better latency bench); without this the
      // ranked chart put 0 % rows first.
      higherIsBetter: activePanel.higherIsBetter ?? viewBenchmark.higherIsBetter,
      results: viewBenchmark.results
        .filter((r) => vals[r.slug] != null && Number.isFinite(vals[r.slug]))
        .map((r) => ({ ...r, ms: { ...r.ms, p50: vals[r.slug] } })),
    };
  }, [viewBenchmark, activePanel]);

  if (!benchmark || !viewBenchmark || !panelViewBenchmark) return null;

  const pendingCls = variantPending
    ? " opacity-40 animate-pulse pointer-events-none"
    : "";
  const pendingLabel = [
    effectiveChain,
    effectiveRegion,
    effectiveKind,
    effectiveTier ? tierOptions.find((t) => t.value === effectiveTier)?.label ?? effectiveTier : null,
  ]
    .filter((v): v is string => !!v && v !== "all")
    .join(" · ");
  const isDraft = viewBenchmark.status === "draft";
  const { fieldMin, fieldMedian, fieldMax, tailMin, tailMax, tailSpread } =
    computeFieldStats(viewBenchmark.results);

  const sharedHeaderActions = (
    <>
      <CsvButton benchmark={viewBenchmark ?? benchmark} range={chartRange} />
      {pageActions}
      <ViewSwitcher allowed={allowedViews} value={view} onChange={setView} />
    </>
  );

  return (
    <>
      {(hasLayerSplit ||
        filteredChainOptions.length > 0 ||
        regionOptions.length > 0 ||
        kindOptions.length > 0 ||
        tierOptions.length > 0 ||
        filteredVenueOptions.length > 0) && (
        <div className="mt-8 space-y-3">
          {tierOptions.length > 0 && (
            <DimensionRow
              label="Access"
              options={tierOptions}
              selected={tier ?? headlineTier}
              onSelect={setTier}
              metaByValue={Object.fromEntries(
                tierOptions
                  .map((o) => [
                    o.value,
                    summarize(
                      variantMap[
                        variantKey(effectiveChain, effectiveRegion, effectiveKind, effectiveVenue, tierParam(o.value))
                      ],
                    ),
                  ])
                  .filter(([, v]) => v !== null) as [string, ChainMeta][]
              )}
            />
          )}
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
          {filteredVenueOptions.length > 0 && (
            <DimensionRow
              label="Venue"
              options={filteredVenueOptions}
              selected={venue ?? fallbackVenue}
              onSelect={(v) => { setVenue(v); setChain(null); }}
              metaByValue={Object.fromEntries(
                filteredVenueOptions
                  .map((o) => [
                    o.value,
                    summarize(
                      variantMap[variantKey(effectiveChain, effectiveRegion, effectiveKind, o.value, effectiveTier)],
                    ),
                  ])
                  .filter(([, v]) => v !== null) as [string, ChainMeta][]
              )}
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
                      variantMap[variantKey(effectiveChain, effectiveRegion, o.value, effectiveVenue, effectiveTier)],
                    ),
                  ])
                  .filter(([, v]) => v !== null) as [string, ChainMeta][]
              )}
            />
          )}
          {filteredChainOptions.length > 0 && (
            <DimensionRow
              label="Chain"
              options={filteredChainOptions}
              selected={chain ?? fallbackChain}
              onSelect={setChain}
              metaByValue={Object.fromEntries(
                filteredChainOptions
                  .map((o) => [
                    o.value,
                    summarize(variantMap[variantKey(o.value, effectiveRegion, effectiveKind, effectiveVenue, effectiveTier)]),
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
                    summarize(variantMap[variantKey(effectiveChain, o.value, effectiveKind, effectiveVenue, effectiveTier)]),
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
                  headerActions={<>{sharedHeaderActions}</>}
                />
              )}
              {view === "rankedBar" && (
                <>
                  {(() => {
                    const tabPanels = (benchmark.metricPanels ?? []).filter(
                      (p) => p.tab !== false,
                    );
                    return tabPanels.length > 0 ? (
                      <MetricViewTabs
                        panels={tabPanels}
                        mainLabel={benchmark.panelMainLabel ?? benchmark.metric}
                        mainDescription={benchmark.panelMainDescription}
                        activeId={activePanelId}
                        onSelect={setActivePanelId}
                        hideMain={hideHeadline}
                      />
                    ) : null;
                  })()}
                <RankedBarChart
                  benchmark={panelViewBenchmark}
                  excluded={excluded}
                  onToggleExclude={toggleExclude}
                  onResetExcluded={resetExcluded}
                  disableTopN={hasLayerSplit}
                  topNControl={topNControl}
                  headerActions={<>{sharedHeaderActions}</>}
                />
                </>
              )}
              {view === "distribution" && (
                <DistributionChart
                  benchmark={viewBenchmark}
                  excluded={excluded}
                  onToggleExclude={toggleExclude}
                  onResetExcluded={resetExcluded}
                  disableTopN={hasLayerSplit}
                  topNControl={topNControl}
                  headerActions={<>{sharedHeaderActions}</>}
                />
              )}
              {view === "donut" && (
                <DonutChart
                  benchmark={viewBenchmark}
                  excluded={excluded}
                  onToggleExclude={toggleExclude}
                  disableTopN={hasLayerSplit}
                  topNControl={topNControl}
                  headerActions={<>{sharedHeaderActions}</>}
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
                        mainLabel={benchmark.panelMainLabel ?? benchmark.metric}
                        mainDescription={benchmark.panelMainDescription}
                        activeId={activePanelId}
                        onSelect={setActivePanelId}
                        hideMain={hideHeadline}
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
                    chain={effectiveChain ?? undefined}
                    excluded={excluded}
                    onToggleExclude={toggleExclude}
                    onResetExcluded={resetExcluded}
                    disableTopN={hasLayerSplit}
                  topNControl={topNControl}
                    headerActions={<>{sharedHeaderActions}</>}
                    seriesOverride={activePanel?.seriesByProvider}
                    seriesOverride7d={activePanel?.seriesByProvider7d}
                    seriesOverride30d={activePanel?.seriesByProvider30d}
                    activePanelId={activePanel?.id ?? null}
                    metricLabelOverride={activePanel?.label}
                    unitOverride={activePanel?.unit}
                    higherIsBetterOverride={activePanel?.higherIsBetter}
                    range={chartRange}
                    onRangeChange={setChartRange}
                    longRangeSeries={hasLongHistory ? hlLongRangeSeries : undefined}
                    longRangeDisabled={hasLongHistory ? hlArchiveDisabled : undefined}
                    longRangeDisabledTitle={
                      hasLongHistory
                        ? "Archive temporarily unavailable"
                        : undefined
                    }
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

          {benchmark.stackedShare && (
            <StackedShareChart slug={benchmark.slug} />
          )}

          <div className={"mt-8 card-soft rounded-xl p-4 sm:p-6 lg:p-8" + pendingCls}>
            {hasLongHistory && longRangeKey ? (
              <>
                <p className="label-mono text-ink-faint mb-4">
                  Product ledger · {longRangeKey} archive
                </p>
                <HlArchiveLeaderboard
                  window={longRangeKey}
                  payload={hlActiveArchive}
                  loading={hlArchiveLoading}
                  knownProviders={viewBenchmark.results.map((r) => ({
                    slug: r.slug,
                    name: r.name,
                  }))}
                />
              </>
            ) : (
              <>
                <h2 className="label-mono text-ink-faint mb-4">
                  {viewBenchmark.unit === "count"
                    ? "Product ledger"
                    : activePanel
                      ? `Product ledger · sorted by ${activePanel.label}`
                      : viewBenchmark.ledgerColumns?.length
                        ? `Product ledger · sorted by ${viewBenchmark.ledgerColumns[0].label}`
                        : "Product ledger · sorted by p50"}
                </h2>
                <LedgerTable benchmark={viewBenchmark} activePanel={activePanel} topN={topN} />
                {/* Visible freshness stamp next to the numbers. Answer
                    engines quote data far more readily when the page says
                    when it was measured. Uses the harness's lastRunAt
                    (real data timestamp), not build time. */}
                {asOfUtc && (
                  <p className="mt-3 text-[11px] text-ink-faint">
                    Data as of{" "}
                    <time dateTime={benchmark.lastRunAt}>{asOfUtc}</time>,
                    refreshed continuously.
                  </p>
                )}
              </>
            )}
          </div>

          {viewBenchmark.unit !== "count" &&
            Object.keys(benchmark.extras.regions).length > 0 && (
              <div className={"mt-8 card-soft rounded-xl p-4 sm:p-6 lg:p-8" + pendingCls}>
                <h2 className="label-mono text-ink-faint mb-4">By region</h2>
                <RegionGrid benchmark={viewBenchmark} />
              </div>
            )}
          {!effectiveTier && headlineCohortBlock}
        </>
      )}
    </>
  );
}
