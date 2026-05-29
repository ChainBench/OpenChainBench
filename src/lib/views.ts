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
  | "distribution"
  | "donut";

const ALLOWED_BY_UNIT: Record<Benchmark["unit"], ViewType[]> = {
  // distribution surfaces tail behaviour (p90/p99 vs p50) which is the
  // signal users actually care about on latency / cost / yield benches.
  // donut is offered everywhere too: on latency / pct / bps it reads as
  // "share of the field's total p50", a perfectly valid (if unusual)
  // comparison the reader can ignore if they don't want it. Putting the
  // option behind the switcher gives the choice instead of guessing.
  ms: ["timeseries", "rankedBar", "distribution", "donut"],
  s: ["timeseries", "rankedBar", "distribution", "donut"],
  bps: ["timeseries", "rankedBar", "distribution", "donut"],
  pct: ["timeseries", "rankedBar", "distribution", "donut"],
  // count + usd previously offered a dedicated Leaderboard view; retired
  // 2026-05-29 in favour of the standard distribution/ranked-bar/donut
  // set so every bench shares the same view affordances.
  count: ["distribution", "rankedBar", "donut", "timeseries"],
  // slots: integer-ish gauge values (Solana slot delta). Same view set as
  // latency benches — timeseries shows step-function patterns over time
  // which is exactly what we want to surface (1 slot vs 2 slots = the
  // operational signal).
  slots: ["timeseries", "rankedBar", "distribution", "donut"],
  usd: ["distribution", "rankedBar", "donut", "timeseries"],
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
  // count + usd benches used to default to the Leaderboard view; that
  // view was retired (2026-05-29). Distribution is the closest read on
  // a single-number-per-provider bench: it shows each provider's value
  // on a shared scale with a coloured spread, which makes outliers
  // obvious without inventing percentile semantics that don't apply.
  if (b.unit === "count" || b.unit === "usd") return "distribution";
  if (b.results.length >= 3 || b.unit === "bps" || b.unit === "pct") {
    return "rankedBar";
  }
  return "timeseries";
}
