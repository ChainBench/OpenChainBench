/**
 * Wire types shared between the spec loader and the rendering layer.
 * Keeping them isolated breaks the import cycle that would otherwise
 * exist between `src/data/benchmarks.ts` and `src/lib/spec.ts`.
 */

export type ProviderType = "protocol" | "aggregator" | "intent" | "relay";

/** Network-layer classification used by benches that mix L1 and L2 chains
 *  in the same provider set (network-fees). Drives the L1/L2/All toggle
 *  pill rendered above the ledger table. */
export type ProviderLayer = "l1" | "l2";

/**
 * Per-provider data availability. Drives whether the leaderboard renders
 * the numbers or a "currently unavailable" stub.
 *
 *  - `live`        : fresh data, all the latency aggregates are real.
 *  - `unavailable` : the underlying source (provider API, the harness
 *                    that scrapes it, the prom job) is not delivering
 *                    samples right now. Numbers are zero placeholders -
 *                    show a soft offline pill, not 0 ms.
 */
export type ProviderAvailability = "live" | "unavailable";

export type ProviderResult = {
  name: string;
  slug: string;
  tag?: string;
  /** Architectural category. Drives the small badge next to the name so
   *  readers know whether comparisons are apples-to-apples. */
  type?: ProviderType;
  /** Optional network-layer classification. When set on every provider of
   *  a bench, the bench page renders an L1/L2/All toggle pill above the
   *  ledger that filters rows by this field. */
  layer?: ProviderLayer;
  ms: { p50: number; p90: number; p99: number; mean: number };
  /** Optional slot-level companion to ms. Used by Solana-native benches
   *  where confirmation is a slot-level event (~400 ms granularity).
   *  When present, the providers table renders a "Slot delta" column
   *  next to the ms columns. */
  slots?: { p50: number; p99: number };
  successRate: number;
  /** Per-provider sample count over the run window. */
  sampleSize?: number;
  /**
   * Sample-health classification derived from sampleSize / expectedN.
   *
   *  - "healthy"     : sampleSize >= 0.5 × expectedN. Render normally.
   *  - "low"         : 0.1 × expectedN <= sampleSize < 0.5 × expectedN.
   *                    Row stays in the ranking with a "Low sample"
   *                    pill and a tooltip explaining the gap.
   *  - "insufficient": sampleSize < 0.1 × expectedN. Row drops out of
   *                    the sorted ranking; aggregate citations should
   *                    read "insufficient data" rather than assert a
   *                    winner.
   *
   * Absent on benches whose spec does not declare `expected_n`, in
   * which case no badge is rendered (legacy display behavior). */
  dataConfidence?: "healthy" | "low" | "insufficient";
  /** Sample-health ratio, 0..1+. Same source as `dataConfidence` but
   *  exposed as the raw fraction for downstream consumers (citable /
   *  stat APIs, dashboards, tooltips). Absent when the spec declares
   *  no expected_n or when sampleSize itself is missing. */
  sampleHealth?: number;
  secondary?: { label: string; value: string };
  /** Defaults to "live" when the provider returns numbers; the spec
   *  loader sets "unavailable" when prom has no data for the p50 / p90 /
   *  p99 queries so the UI can render a soft offline state instead of
   *  zero values. */
  availability?: ProviderAvailability;
  /** True when the provider is part of the bench's declared cohort and
   *  its reliability counters (spec `success` / `sample_size` queries,
   *  rpc_call_total-backed) still return samples for the current view,
   *  but no latency percentile exists — probes keep running and
   *  (nearly) all fail, so the latency series went Prom-stale. Rendered
   *  as an unranked, muted "unresponsive" row at the bottom of the
   *  ledger carrying its success rate, instead of silently vanishing
   *  from the leaderboard. Always paired with availability="unavailable"
   *  so every ranking surface (liveResults, hub best/fastest, best_name
   *  placeholders) keeps excluding it from winner claims. */
  unresponsive?: boolean;
  /** Carry-forward bookkeeping written by the materialization worker:
   *  observedAt = epoch ms of the last successful Prom read behind these
   *  numbers; staleSince = first failed cycle after it. Absent on data
   *  loaded live (always fresh by construction). Renderers derive
   *  fresh/stale/dead from this at render time. */
  meta?: { observedAt: number; staleSince?: number };
  /** The raw PromQL query that produced this provider's p50 value.
   *  Surfaced in the chart hover tooltip so readers can see exactly
   *  how the headline number was computed, not just trust it. */
  query?: string;
  /** Single-line plain-English explanation of how this provider's
   *  headline value is computed. Rendered as the leaderboard-row
   *  hover tooltip. Authored per-bench in YAML (provider.formula). */
  formula?: string;
  /** Short-window liveness verdict derived at load time from the spec's
   *  `queries.live_activity` scalar and the bench-level `probe_ok`
   *  gate. Only populated when the spec declares those queries.
   *   - "healthy": recent events arrived (activity > 0).
   *   - "down": no recent events AND probe_ok confirmed our end is
   *             fine — the provider's live feed is silent, values
   *             shown are last-known. Renderers should badge it.
   *   - "unknown": probe_ok reports our side is broken (harness or
   *                Prom scrape), OR the activity query itself
   *                returned no sample. Suppress the badge either way
   *                so a probe hiccup can't fake-flag every provider.
   *  Absent when the spec doesn't declare live_activity; UI must
   *  behave identically to today for those benches. */
  liveStatus?: "healthy" | "down" | "unknown";
};

/** One provider's standing inside a (chain, region) ranking cell. */
export type CellRankEntry = { slug: string; p50: number };

export type RegionPoint = {
  region: "us-east" | "eu-west" | "ap-southeast" | "global";
  p50: number;
};

/** Dense per-window series aligned to the Prom query_range grid. `null`
 *  marks an evaluation bucket with no sample (harness outage, provider
 *  offline) so renderers can draw an honest gap instead of silently
 *  compressing the X-axis. Older worker blobs predate the nulls and
 *  carry bare number arrays — a valid subset of this type. */
export type Series24h = (number | null)[];

export type MetricPanel = {
  id: string;
  label: string;
  description?: string;
  metric: string;
  unit: "ms" | "s" | "sec" | "pct" | "bps" | "bp" | "count" | "slots" | "usd" | "gwei";
  higherIsBetter: boolean;
  /** When false the panel is data-only (feeds ledger column window
   *  variants) and renders no chart tab. */
  tab?: boolean;
  /** Per-provider scalar values, keyed by provider slug. Providers with no
   *  live data for this metric are omitted; the renderer renders them as
   *  "no data" instead of zero. */
  values: Record<string, number>;
  /** Carry-forward meta per provider slug, mirroring ProviderResult.meta
   *  for panel values. Written by the materialization worker only. */
  valuesMeta?: Record<string, { observedAt: number; staleSince?: number }>;
  /** Per-provider 24h time-series (72 points by default), keyed by
   *  provider slug. Powers the multi-line chart view of the panel.
   *  Providers with no Prom data for the query are absent from the map.
   *  Entries are dense with nulls for empty buckets (see Series24h). */
  seriesByProvider?: Record<string, Series24h>;
  /** Per-provider 7 day time-series (84 points by default). Used by the
   *  chart's 7D range tab when a panel is active. */
  seriesByProvider7d?: Record<string, Series24h>;
  /** Per-provider 30 day time-series (60 points by default). Used by the
   *  chart's 30D range tab when a panel is active. */
  seriesByProvider30d?: Record<string, Series24h>;
};

export type ResultExtras = {
  /** 24h-window global series per provider. sparklines + default chart view. */
  series24h: Record<string, Series24h>;
  /** 7-day-window global series per provider. chart's "7d" range. */
  series7d?: Record<string, Series24h>;
  /** 30-day-window global series per provider. chart's "30d" range. */
  series30d?: Record<string, Series24h>;
  /** Per-region 24h series, when the spec defines region.series queries. */
  seriesByRegion24h?: Record<string, Record<string, Series24h>>;
  /** Per-region 7d series. */
  seriesByRegion7d?: Record<string, Record<string, Series24h>>;
  /** Per-region 30d series. */
  seriesByRegion30d?: Record<string, Record<string, Series24h>>;
  regions: Record<string, RegionPoint[]>;
};

export type Benchmark = {
  slug: string;
  number: string;
  /** Epoch ms of the worker sweep that produced this snapshot. Absent on
   *  live-loaded data. Powers the "data as of Xs ago" freshness pill. */
  dataAsOf?: number;
  title: string;
  seoTitle?: string;
  /** Optional SEO-tuned meta description. Overrides the default headline
   *  + subtitle concatenation. */
  seoDescription?: string;
  /** Optional SSR-rendered intro paragraph displayed under the H1. */
  seoIntro?: string;
  /** Optional warning callout rendered as a visible card under the H1,
   *  before the leaderboard. Use when the metric is easy to misread. */
  disclaimer?: string;
  /** Optional FAQ entries. Surfaced both as visible Q&A blocks and as
   *  FAQPage JSON-LD for rich-result eligibility. */
  faq?: { q: string; a: string }[];
  /** Optional per-chain explainer blocks rendered as H2-anchored sections
   *  below the main chart. Targets long-tail "X chain {metric}" queries
   *  that benefit from a dedicated on-page anchor (#ethereum, #solana, ...).
   *  Body strings go through the template resolver so {{p50:slug}} etc.
   *  resolve to live numbers. */
  perChainExplainer?: { slug: string; h2: string; body: string }[];
  subtitle: string;
  lastRunAt: string;
  /** Runtime status. flipped to "draft" when Prom returns no data, even if
   *  the spec is editorially published. Use `editorialStatus` to gate
   *  visibility from public surfaces. */
  status: "live" | "draft";
  /** What the spec author declared in the YAML (`status:` field, default
   *  "live"). Stays "live" even when Prom has no samples yet, so a
   *  published-but-awaiting-data bench remains visible. */
  editorialStatus: "live" | "draft";
  sampleSize: number;
  /** Spec-declared expected sample count per provider over the bench's
   *  window. Drives the per-provider sample-health badge logic. Absent
   *  when the spec author chose not to declare it (low cadence benches
   *  whose healthy n cannot be computed deterministically). */
  expectedN?: number;
  /** Aggregate sample-health for the bench. Derived from the median of
   *  the per-provider healths; "insufficient" silences the leader
   *  assertion at every citable surface. Absent when expectedN is. */
  dataConfidence?: "healthy" | "low" | "insufficient";
  abstract: string;
  metric: string;
  unit: "ms" | "s" | "sec" | "pct" | "bps" | "bp" | "count" | "slots" | "usd" | "gwei";
  higherIsBetter: boolean;
  /** Optional drill-down dimensions exposed by the bench. When set, the
   * bench page renders one tab selector per dimension and the queries get
   * a matching `<label>="<value>"` injected. */
  dimensions?: {
    chain?: { value: string; label: string }[];
    region?: { value: string; label: string }[];
    kind?: { value: string; label: string }[];
    venue?: { value: string; label: string }[];
  };
  category: "Aggregators" | "Bridges" | "Blockchains" | "Trading" | "Wallets" | "RPCs" | "NFT APIs" | "Explorers" | "RWA";
  results: ProviderResult[];
  /** Per-chain leader, computed only on the unfiltered ("All chains") view
   *  when the spec declares `dimensions.chain`. Key = chain slug from the
   *  YAML (e.g. "solana", "base", "bnb"); excludes "all". Value = the live
   *  ProviderResult that leads on that chain.
   *
   *  Motivation: the unfiltered aggregate is biased by chain mix (e.g.
   *  Solana 400 ms slots vs Base 2 s blocks make Solana-only providers
   *  mechanically beat cross-chain ones on head-lag). Per-chain winners
   *  are computed via extra Prom queries with `chain="<x>"` injected, so
   *  headline copy / OG image / badge endpoint can call out the leader on
   *  each chain instead of one biased global winner. */
  bestPerChain?: Record<string, ProviderResult>;
  /** Per-chain trailing provider, populated in lockstep with
   *  `bestPerChain` (same key set, same population conditions). Powers
   *  the `{{worst_name:chain:X}}` / `{{worst_p50:chain:X}}` editorial
   *  placeholders. */
  worstPerChain?: Record<string, ProviderResult>;
  /** Set of provider slugs that returned live data on each chain. Same
   *  key set as `bestPerChain`. Powers the per-chain rank chips on
   *  /products/[slug] so chain-restricted providers (Solana-only like
   *  GMGN) only get chips on chains they actually compete on, instead
   *  of inheriting their aggregate position on every chain in the
   *  bench. */
  providersPerChain?: Record<string, string[]>;
  /** Full per-cell rankings from the spec's `rank_matrix_query`, computed
   *  only on the unfiltered view. Key = `<chain>|<region>` where a side is
   *  "all" when the bench doesn't declare that dimension OR for derived
   *  marginals (mean over the collapsed dimension). Value = providers
   *  sorted best-first by the bench's direction.
   *
   *  Motivation: per-chain ranks built from cross-region averages hide
   *  region-restricted leaders (dRPC winning from Singapore only still
   *  read as the global chain leader). Cells make the honest claim
   *  ("#1 on BNB Chain from Singapore") computable. */
  cellRanks?: Record<string, CellRankEntry[]>;
  findings: string[];
  methodology: string[];
  source: string;
  extras: ResultExtras;
  /** Optional companion metrics surfaced as switchable mini leaderboards
   *  below the main table. Populated by the spec loader from
   *  `metric_panels` in the YAML. */
  metricPanels?: MetricPanel[];
  panelMainLabel?: string;
  /** Optional per-bench relabeling of the ledger's aggregate columns.
   *  Declared by benches whose unit has no percentile semantics (the
   *  p50/p90/p99/mean slots are repurposed, e.g. USD revenue leaderboards)
   *  so the table headers describe what each slot actually holds. The
   *  first column is the headline (sort key, data bar, mobile column). */
  ledgerColumns?: LedgerColumn[];
};

export type LedgerColumn = {
  label: string;
  /** Reads the provider's headline slot value. */
  slot?: "p50" | "p90" | "p99" | "mean";
  /** Reads the per-provider values of a metric_panels entry by id. */
  panel?: string;
  /** Display unit override; defaults to the panel's unit (panel columns)
   *  or the bench unit (slot columns). */
  unit?: "ms" | "s" | "sec" | "pct" | "bps" | "bp" | "count" | "slots" | "usd" | "gwei";
  /** Per-window value sources for the ledger's timeframe toggle: window
   *  key to metric_panels id. Columns without a mapping keep their 24h
   *  value when a longer window is selected. */
  windows?: Partial<Record<"7d" | "30d", string>>;
};
