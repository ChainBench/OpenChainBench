import type { Benchmark } from "@/types/benchmark";

type WindowBench = Pick<Benchmark, "unit"> &
  Partial<Pick<Benchmark, "hasDistribution" | "valueKind" | "window">>;

/**
 * How to describe a bench's headline number, in one place.
 *
 * Three kinds of value hide behind the same p50 slot:
 *
 *   a real percentile of a 24h distribution   -> "p50, 24h"
 *   a rolling-window aggregate                -> "24h" / "24h avg"
 *   the latest reading of a slow gauge        -> "latest value"
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
  if (b.hasDistribution === false) return "Value";
  return "p50";
}

/** Sentence fragment for a block intro: "Latest value per chain" or
 *  "Live p50 over the last 24 hours". */
export function valueReadingPhrase(b: WindowBench): string {
  if (b.valueKind === "latest") return "Latest value";
  const win = b.window ?? "24h";
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
}): "latest" | undefined {
  const providers = spec.providers ?? [];
  let sawQueries = false;
  for (const p of providers) {
    const q = p.queries?.p50?.trim();
    if (!q) continue;
    sawQueries = true;
    if (!q.startsWith("last_over_time(")) return undefined;
  }
  return sawQueries ? "latest" : undefined;
}
