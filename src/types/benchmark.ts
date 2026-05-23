/**
 * Wire types shared between the spec loader and the rendering layer.
 * Keeping them isolated breaks the import cycle that would otherwise
 * exist between `src/data/benchmarks.ts` and `src/lib/spec.ts`.
 */

export type ProviderType = "protocol" | "aggregator" | "intent" | "relay";

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
  ms: { p50: number; p90: number; p99: number; mean: number };
  /** Optional slot-level companion to ms. Used by Solana-native benches
   *  where confirmation is a slot-level event (~400 ms granularity).
   *  When present, the providers table renders a "Slot delta" column
   *  next to the ms columns. */
  slots?: { p50: number; p99: number };
  successRate: number;
  /** Per-provider sample count over the run window. */
  sampleSize?: number;
  secondary?: { label: string; value: string };
  /** Defaults to "live" when the provider returns numbers; the spec
   *  loader sets "unavailable" when prom has no data for the p50 / p90 /
   *  p99 queries so the UI can render a soft offline state instead of
   *  zero values. */
  availability?: ProviderAvailability;
  /** The raw PromQL query that produced this provider's p50 value.
   *  Surfaced in the chart hover tooltip so readers can see exactly
   *  how the headline number was computed, not just trust it. */
  query?: string;
};

export type RegionPoint = {
  region: "us-east" | "eu-west" | "ap-southeast" | "global";
  p50: number;
};

export type Series24h = number[];

export type ResultExtras = {
  /** 24h-window global series per provider. sparklines + default chart view. */
  series24h: Record<string, Series24h>;
  /** 7-day-window global series per provider. chart's "7d" range. */
  series7d?: Record<string, Series24h>;
  /** Per-region 24h series, when the spec defines region.series queries. */
  seriesByRegion24h?: Record<string, Record<string, Series24h>>;
  /** Per-region 7d series. */
  seriesByRegion7d?: Record<string, Record<string, Series24h>>;
  regions: Record<string, RegionPoint[]>;
};

export type Benchmark = {
  slug: string;
  number: string;
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
  abstract: string;
  metric: string;
  unit: "ms" | "s" | "pct" | "bps" | "count" | "slots";
  higherIsBetter: boolean;
  /** Optional drill-down dimensions exposed by the bench. When set, the
   * bench page renders one tab selector per dimension and the queries get
   * a matching `<label>="<value>"` injected. */
  dimensions?: {
    chain?: { value: string; label: string }[];
    region?: { value: string; label: string }[];
  };
  category: "Aggregators" | "Bridges" | "Blockchains" | "Trading" | "Wallets" | "RPCs";
  results: ProviderResult[];
  findings: string[];
  methodology: string[];
  source: string;
  extras: ResultExtras;
};
