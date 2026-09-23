import type { Benchmark } from "@/types/benchmark";

type WindowBench = Pick<Benchmark, "unit"> &
  Partial<Pick<Benchmark, "hasDistribution" | "valueKind" | "window">>;

/** "30d" -> "30 days", "7d" -> "7 days", anything else as written. */
const windowDays = (win: string): string => {
  const m = /^(\d+)d$/.exec(win);
  return m ? `${m[1]} days` : win;
};

/**
 * How to describe a bench's headline number, in one place.
 *
 * Three kinds of value hide behind the same p50 slot:
 *
 *   a real percentile of a 24h distribution   -> "p50, 24h"
 *   a rolling-window aggregate                -> "24h" / "24h avg"
 *   the latest reading of a slow gauge        -> "latest value"
 *   a window average scaled to the window     -> "30 days at the average daily rate"
 *
 * The fourth is perp-funding-cost-30d: `avg_over_time(...[30d:1h]) * 30`
 * is a month of funding, and "(30d avg)" would read as a daily cost thirty
 * times too high in the quotable sentence (review 2026-09-23).
 *
 * The third had no wording, so a bench whose queries are all
 * `last_over_time(...)` still announced a 24-hour median: 42 occurrences on
 * bench 273 alone, including the TL;DR an answer engine is invited to
 * quote, the Dataset variableMeasured and every product-page rank. Its own
 * methodology said on the same page that the three percentiles are equal by
 * construction (SEO audit 2026-09-23, round 3).
 *
 * The window claim was false twice over there: the bench had about ninety
 * minutes of scrapes behind a label that said 24 hours.
 */
export function valueQualifier(b: WindowBench): string {
  const win = b.window ?? "24h";
  if (b.valueKind === "latest") return "latest value";
  if (b.valueKind === "total") return `${windowDays(win)} at the average daily rate`;
  // A quantile_over_time(0.5, ...) headline is a median whatever the unit;
  // the pct/bps rule below would call the stock benches' 7d median an
  // average (review 2026-09-23).
  if (b.valueKind === "median") return `p50, ${win}`;
  if (b.unit === "usd" || b.unit === "count") return win;
  if (b.unit === "pct" || b.unit === "bps" || b.unit === "bp") return `${win} avg`;
  if (b.hasDistribution === false) return win;
  return `p50, ${win}`;
}

/** The same thing in brackets, for a sentence: "$8.21B (latest value)". */
export function valueSuffix(b: WindowBench): string {
  return `(${valueQualifier(b)})`;
}

/** Column header and infobox label: "Latest" or "p50". */
export function valueColumnLabel(b: WindowBench): string {
  if (b.valueKind === "latest") return "Latest";
  if (b.valueKind === "total") return "Total";
  if (b.hasDistribution === false) return "Value";
  return "p50";
}

/** Sentence fragment for a block intro: "Latest value per chain" or
 *  "Live p50 over the last 24 hours". */
export function valueReadingPhrase(b: WindowBench): string {
  if (b.valueKind === "latest") return "Latest value";
  const win = b.window ?? "24h";
  if (b.valueKind === "total") return `${windowDays(win)} at the average daily rate`;
  if (b.hasDistribution === false) return `Live value over the last ${win === "24h" ? "24 hours" : win}`;
  return `Live p50 over the last ${win === "24h" ? "24 hours" : win}`;
}

/**
 * "latest" when every provider's headline query is a point read. A bench
 * built on `last_over_time(...)` measures a gauge as it stands, so calling
 * the result a 24-hour median claims a statistic nothing computed.
 *
 * Lives here rather than in spec.ts because both loaders need it and
 * load.ts must not import spec.ts (spec.ts imports load.ts). Deriving it
 * in only one of them is how the first attempt shipped: the overlay had
 * it, the materialize path did not, and the page kept saying "(24h)".
 */
export function specValueKind(spec: {
  providers?: { queries?: { p50?: string } }[];
}): "latest" | "total" | "median" | undefined {
  const providers = spec.providers ?? [];
  let sawQueries = false;
  let allLatest = true;
  let allTotal = true;
  let allMedian = true;
  for (const p of providers) {
    const q = p.queries?.p50?.trim();
    if (!q) continue;
    sawQueries = true;
    if (!q.startsWith("last_over_time(")) allLatest = false;
    // "total": a window average scaled to the window's length
    // (`avg_over_time(x[30d:1h]) * 30` on perp-funding-cost-30d), a month
    // at the average daily rate, which the qualifier must not call an
    // average of the month.
    if (!/^avg_over_time\(.+\)\s*\*\s*\d+$/.test(q)) allTotal = false;
    if (!/^quantile_over_time\(0\.50?,/.test(q)) allMedian = false;
  }
  if (!sawQueries) return undefined;
  if (allLatest) return "latest";
  if (allTotal) return "total";
  if (allMedian) return "median";
  return undefined;
}
