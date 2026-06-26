import type { Benchmark } from "@/types/benchmark";
import { isAll } from "@/lib/dimensions";
import { SECONDS_PER_DAY, SECONDS_PER_HOUR } from "@/lib/time-constants";

export type Range = "1h" | "6h" | "24h" | "7d" | "30d";

export const RANGES: Range[] = ["1h", "6h", "24h", "7d", "30d"];

export const RANGE_HOURS: Record<Range, number> = {
  "1h": 1,
  "6h": 6,
  "24h": 24,
  "7d": 168,
  "30d": 720,
};

// How many points spec.ts (src/lib/spec.ts:prom.series) requests for each
// range. Used to anchor partial series correctly. When a metric has
// fewer real samples than EXPECTED (harness started recently, or a
// provider went offline mid-window), we anchor the rightmost point to
// "now" and step earlier points backwards by 1/EXPECTED of the chart
// width. The unfilled left side is honest, not stretched.
export const RANGE_EXPECTED_POINTS: Record<Range, number> = {
  "1h": 3,
  "6h": 18,
  "24h": 72,
  "7d": 84,
  "30d": 60,
};

export const RANGE_LABEL: Record<Range, string> = {
  "1h": "last hour",
  "6h": "last 6 hours",
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
};

export const REGION_LABEL: Record<string, string> = {
  "us-east": "US-East",
  "eu-west": "EU-West",
  "ap-southeast": "Singapore",
  sgp: "Singapore",
  global: "Global",
};

export type LineWithColor = {
  slug: string;
  name: string;
  color: string;
  values: number[];
  excluded: boolean;
};

export function pickSeries(
  benchmark: Benchmark,
  slug: string,
  range: Range,
  region: string
): number[] {
  const allRegion = isAll(region);

  if (!allRegion) {
    // For YAML specs that do not declare per-region `queries.regions[]`,
    // the per-region map is empty. The top-level series (`series24h[slug]`)
    // is still correctly region-filtered because `applyDimensionsToSpec`
    // injects the region label into the spec's top-level `series` query
    // before Prom is hit. Fall back to that instead of rendering empty.
    if (range === "30d") {
      const byRegion = benchmark.extras.seriesByRegion30d?.[slug]?.[region];
      if (byRegion && byRegion.length > 0) return byRegion;
      return benchmark.extras.series30d?.[slug] ?? [];
    }
    if (range === "7d") {
      const byRegion = benchmark.extras.seriesByRegion7d?.[slug]?.[region];
      if (byRegion && byRegion.length > 0) return byRegion;
      return benchmark.extras.series7d?.[slug] ?? [];
    }
    const baseRegion = benchmark.extras.seriesByRegion24h?.[slug]?.[region];
    const base =
      baseRegion && baseRegion.length > 0
        ? baseRegion
        : (benchmark.extras.series24h[slug] ?? []);
    if (range === "24h") return base;
    const ratio = RANGE_HOURS[range] / 24;
    const take = Math.max(2, Math.round(base.length * ratio));
    return base.slice(-take);
  }

  const s24 = benchmark.extras.series24h[slug] ?? [];
  const s7 = benchmark.extras.series7d?.[slug] ?? [];
  const s30 = benchmark.extras.series30d?.[slug] ?? [];
  if (range === "30d") return s30;
  if (range === "7d") return s7;
  if (range === "24h") return s24;
  const ratio = RANGE_HOURS[range] / 24;
  const take = Math.max(2, Math.round(s24.length * ratio));
  return s24.slice(-take);
}

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

/**
 * X-axis ticks for the visible window. When the chart is zoomed the
 * right edge isn't `now` anymore — pass `endHoursAgo` to offset every
 * tick by that many hours (the rightmost tick becomes `−{endHoursAgo}h`
 * instead of `now`). The label granularity (minutes / hours / days) is
 * picked from the *visible* windowHours so a 6-hour zoom-in of a 24h
 * range gets minute-level ticks.
 */
export function buildXTicks(windowHours: number, endHoursAgo: number = 0) {
  const ticks: { pct: number; label: string }[] = [];
  const step = 0.25;
  for (let p = 0; p <= 1; p += step) {
    const ago = endHoursAgo + windowHours * (1 - p);
    let label: string;
    if (ago < 0.001) label = "now";
    else if (windowHours <= 6) {
      const m = Math.round(ago * 60);
      label = `−${m}m`;
    } else if (windowHours <= 48) {
      label = `−${Math.round(ago)}h`;
    } else {
      label = `−${(ago / 24).toFixed(0)}d`;
    }
    ticks.push({ pct: p, label });
  }
  return ticks;
}

export function formatHoursAgo(hoursAgo: number, windowHours: number): string {
  if (hoursAgo <= 0.001) return "now";
  if (windowHours <= 6) {
    const m = Math.round(hoursAgo * 60);
    return `−${m} min`;
  }
  if (windowHours <= 48) {
    const h = Math.floor(hoursAgo);
    const m = Math.round((hoursAgo - h) * 60);
    if (h === 0) return `−${m} min`;
    return m > 0 ? `−${h}h ${m}m` : `−${h}h`;
  }
  const d = Math.floor(hoursAgo / 24);
  const h = Math.round(hoursAgo - d * 24);
  return d === 0 ? `−${h}h` : h > 0 ? `−${d}d ${h}h` : `−${d}d`;
}

// niceTicks picks rounded y-axis bounds + tick values so labels read as
// 0%, 25%, 50%, 75%, 100% rather than 18.2%, 36.4%, 54.6%, 72.8%.
export function niceTicks(
  dataMin: number,
  dataMax: number,
  targetCount: number
): { lo: number; hi: number; yTicks: number[] } {
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
    return { lo: 0, hi: 1, yTicks: [0, 0.25, 0.5, 0.75, 1] };
  }
  if (dataMin === dataMax) {
    const v = dataMin;
    return { lo: v - 1, hi: v + 1, yTicks: [v - 1, v, v + 1] };
  }
  const rawSpan = dataMax - dataMin;
  const rawStep = rawSpan / targetCount;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  // Pick the smallest "nice" step >= raw step. 1, 2, 2.5, 5, 10
  let niceStep: number;
  if (norm <= 1) niceStep = 1;
  else if (norm <= 2) niceStep = 2;
  else if (norm <= 2.5) niceStep = 2.5;
  else if (norm <= 5) niceStep = 5;
  else niceStep = 10;
  niceStep *= mag;
  // Clamp the floor to zero only for non-negative data: latency-style
  // charts shouldn't waste space below zero, but signed series (funding
  // rates) must plot negative values inside the frame, not below the
  // x-axis (observed: Binance/OKX rendered under the axis line).
  const flooredLo = Math.floor(dataMin / niceStep) * niceStep;
  const lo = dataMin >= 0 ? Math.max(0, flooredLo) : flooredLo;
  const hi = Math.ceil(dataMax / niceStep) * niceStep;
  const yTicks: number[] = [];
  for (let v = lo; v <= hi + niceStep / 2; v += niceStep) yTicks.push(v);
  return { lo, hi, yTicks };
}

export function fmtTick(v: number, unit: string) {
  if (v === 0) return "0";
  if (unit === "pct") {
    if (v >= 1) return `${v.toFixed(1)}%`;
    if (v >= 0.1) return `${v.toFixed(2)}%`;
    return `${v.toFixed(3)}%`;
  }
  if (unit === "bps") {
    const pct = v / 100;
    if (pct >= 1) return `${pct.toFixed(1)}%`;
    return `${pct.toFixed(2)}%`;
  }
  if (unit === "usd") {
    const abs = Math.abs(v);
    if (abs >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
    if (abs >= 1) return `$${v.toFixed(0)}`;
    if (abs >= 0.01) return `$${v.toFixed(2)}`;
    return `$${v.toFixed(4)}`;
  }
  if (unit === "count") {
    const abs = Math.abs(v);
    if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return `${Math.round(v)}`;
  }
  if (unit === "bp") {
    const abs = Math.abs(v);
    return `${v.toFixed(abs < 10 ? 2 : abs < 100 ? 1 : 0)}bps`;
  }
  if (unit === "sec") {
    if (v >= SECONDS_PER_DAY) return `${(v / SECONDS_PER_DAY).toFixed(1)}d`;
    if (v >= SECONDS_PER_HOUR) return `${(v / SECONDS_PER_HOUR).toFixed(1)}h`;
    if (v >= 60) return `${(v / 60).toFixed(0)}m`;
    return `${v.toFixed(v >= 10 ? 0 : 1)}s`;
  }
  if (unit === "s") {
    const s = v / 1000;
    if (s >= 60) return `${(s / 60).toFixed(0)}m`;
    return `${s.toFixed(s >= 10 ? 0 : 1)}s`;
  }
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.round(v)}ms`;
}
