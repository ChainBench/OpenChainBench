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
  /** 24h-window time-series — used by sparklines and the default chart view. */
  series24h: Record<string, Series24h>;
  /** 7-day-window time-series — used by the chart's "7d" range view. */
  series7d?: Record<string, Series24h>;
  regions: Record<string, RegionPoint[]>;
};

export type Benchmark = {
  slug: string;
  number: string;
  title: string;
  subtitle: string;
  lastRunAt: string;
  status: "live" | "draft";
  sampleSize: number;
  abstract: string;
  metric: string;
  unit: "ms" | "s" | "pct" | "bps";
  category: "Aggregators" | "Bridges" | "Data" | "Wallets" | "RPCs";
  results: ProviderResult[];
  findings: string[];
  methodology: string[];
  source: string;
  extras: ResultExtras;
};
