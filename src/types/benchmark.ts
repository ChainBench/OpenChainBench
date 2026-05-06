/**
 * Wire types shared between the spec loader and the rendering layer.
 * Keeping them isolated breaks the import cycle that would otherwise
 * exist between `src/data/benchmarks.ts` and `src/lib/spec.ts`.
 */

export type ProviderResult = {
  name: string;
  slug: string;
  tag?: string;
  ms: { p50: number; p90: number; p99: number; mean: number };
  successRate: number;
  /** Per-provider sample count over the run window. */
  sampleSize?: number;
  secondary?: { label: string; value: string };
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
  subtitle: string;
  lastRunAt: string;
  status: "live" | "draft";
  sampleSize: number;
  abstract: string;
  metric: string;
  unit: "ms" | "s" | "pct" | "bps" | "count";
  higherIsBetter: boolean;
  /** Optional drill-down dimensions exposed by the bench. Currently only
   * `chain` is wired up. when set, the bench page renders a chain-tab
   * filter and the queries get a chain="X" label injected. */
  dimensions?: { chain?: { value: string; label: string }[] };
  category: "Aggregators" | "Bridges" | "Data" | "Wallets" | "RPCs";
  results: ProviderResult[];
  findings: string[];
  methodology: string[];
  source: string;
  extras: ResultExtras;
};
