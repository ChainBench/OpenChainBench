/**
 * Citation helpers shared between the JSON API and the UI buttons. Single
 * source of truth for the headline sentence and quote string that
 * everyone (LLMs, journalists, ourselves) sees.
 */

import type { Benchmark } from "@/types/benchmark";
import { liveResults } from "@/lib/provider-filters";
import { fmtUnit } from "@/lib/format";

/** Median value of the benchmark (the field shown in the headline). */
export function fieldValue(b: Benchmark): number | null {
  if (b.status !== "live") return null;
  const live = liveResults(b.results);
  if (live.length === 0) return null;
  const sorted = [...live].sort((a, c) =>
    b.higherIsBetter ? c.ms.p50 - a.ms.p50 : a.ms.p50 - c.ms.p50
  );
  return sorted[0].ms.p50;
}

/** Who is currently #1 on this benchmark, if any. */
export function leader(b: Benchmark): { name: string; slug: string; value: number } | null {
  if (b.status !== "live") return null;
  const live = liveResults(b.results);
  if (live.length === 0) return null;
  const sorted = [...live].sort((a, c) =>
    b.higherIsBetter ? c.ms.p50 - a.ms.p50 : a.ms.p50 - c.ms.p50
  );
  return { name: sorted[0].name, slug: sorted[0].slug, value: sorted[0].ms.p50 };
}

/** Honest window wording per unit. "(p50, 24h)" is only true for latency
 *  style benches; USD revenue and count benches repurpose the p50 slot as
 *  a plain rolling-window figure and percentile wording would mislead. */
function windowSuffix(unit: string): string {
  if (unit === "usd" || unit === "count") return "(24h)";
  if (unit === "pct" || unit === "bps") return "(24h avg)";
  return "(p50, 24h)";
}

/** Short factual sentence ready to paste into an article. Templated, no LLM. */
export function headlineSentence(b: Benchmark): string {
  const top = leader(b);
  if (!top) return `${b.title}. Awaiting first run.`;
  const value = fmtUnit(top.value, b.unit);
  return `${top.name} leads ${b.metric.toLowerCase()} at ${value} ${windowSuffix(b.unit)} on ${b.title}.`;
}

/** Pasteable attribution string. Standard convention: "<sentence> Source: OpenChainBench (url)". */
export function citationQuote(b: Benchmark, origin: string): string {
  const sentence = headlineSentence(b);
  return `${sentence} Source: OpenChainBench (${origin}/benchmarks/${b.slug}).`;
}

/** Pre-formatted citation strings (Plain / BibTeX / APA) for the page
 *  `<CiteBlock>` and the public JSON endpoints. Computed server-side so
 *  the same canonical wording lands in HTML, in the API, and in whatever
 *  an LLM scrapes. Date is computed from the current request time and
 *  spelled out in ISO so journalists and BibTeX both stay happy. */
export type CiteBundle = {
  plain: string;
  bibtex: string;
  apa: string;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function citeBundle(
  b: Pick<Benchmark, "slug" | "title">,
  origin: string,
  now: Date = new Date(),
): CiteBundle {
  const url = `${origin}/benchmarks/${b.slug}`;
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const isoDate = `${yyyy}-${mm}-${dd}`;
  const longDate = `${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()}, ${yyyy}`;
  const bibKey = `ocb_${b.slug.replace(/-/g, "_")}`;
  return {
    plain: `OpenChainBench. "${b.title}". Retrieved ${isoDate}. ${url}`,
    bibtex: `@misc{${bibKey},\n  author = {OpenChainBench},\n  title  = {${b.title}},\n  year   = {${yyyy}},\n  url    = {${url}},\n  note   = {Retrieved ${isoDate}}\n}`,
    apa: `OpenChainBench. (${yyyy}). ${b.title}. Retrieved ${longDate}, from ${url}`,
  };
}

/** Compact sparkline (last N points, 24h) for the JSON payload. */
export function sparklineFor(b: Benchmark, providerSlug?: string): number[] {
  const series = b.extras.series24h ?? {};
  const pick = providerSlug && series[providerSlug] ? series[providerSlug] : firstSeries(series);
  return pick ?? [];
}

function firstSeries(s: Record<string, number[]>): number[] | null {
  for (const k of Object.keys(s)) {
    const v = s[k];
    if (v && v.length > 0) return v;
  }
  return null;
}
