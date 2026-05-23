import type { Benchmark } from "@/types/benchmark";

/**
 * Chart view types the bench detail page can render. Kept narrow on
 * purpose - 3 options is the upper bound where a segmented icon control
 * stays readable (Vercel / Datadog / Grafana viewer-mode all converge
 * around this for read-only dashboards).
 *
 * Adding a new view = add the slug here, update VIEW_META in the
 * switcher, update ALLOWED_BY_UNIT below, and dispatch on it in
 * BenchmarkBody. No per-bench yml field needed: every bench inherits the
 * valid set from its `unit`, so a brand-new bench gets the right options
 * the moment its yml is loaded.
 */
export type ViewType =
  | "timeseries"
  | "rankedBar"
  | "countLeaderboard"
  | "distribution"
  | "donut";

const ALLOWED_BY_UNIT: Record<Benchmark["unit"], ViewType[]> = {
  // distribution surfaces tail behaviour (p90/p99 vs p50) which is the
  // signal users actually care about on latency / cost / yield benches.
  ms: ["timeseries", "rankedBar", "distribution"],
  s: ["timeseries", "rankedBar", "distribution"],
  bps: ["timeseries", "rankedBar", "distribution"],
  pct: ["timeseries", "rankedBar", "distribution"],
  // donut only makes sense when each provider's value is a share of a
  // meaningful total. count benches with market-share semantics
  // (solana-tx-landing) get the most out of it; other count benches
  // also render but the slices represent the relative size of each
  // provider's footprint, which is still a useful read.
  count: ["countLeaderboard", "rankedBar", "donut", "timeseries"],
};

/**
 * Views the bench is allowed to render. Driven entirely by `unit` so a
 * new bench is auto-categorised the day its yml lands - zero per-bench
 * config to maintain.
 */
export function viewsForBenchmark(b: Benchmark): ViewType[] {
  return ALLOWED_BY_UNIT[b.unit] ?? ["timeseries"];
}

/**
 * Server-rendered default. Mirrors the heuristic the page used before
 * the switcher existed, so an anonymous user with no localStorage hint
 * sees the same view they always saw - the switcher only kicks in on
 * explicit preference change.
 */
export function defaultViewFor(b: Benchmark): ViewType {
  if (b.unit === "count") return "countLeaderboard";
  if (b.results.length >= 3 || b.unit === "bps" || b.unit === "pct") {
    return "rankedBar";
  }
  return "timeseries";
}
