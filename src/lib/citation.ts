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

/** Short factual sentence ready to paste into an article. Templated, no LLM. */
export function headlineSentence(b: Benchmark): string {
  const top = leader(b);
  if (!top) return `${b.title}. Awaiting first run.`;
  const value = fmtUnit(top.value, b.unit);
  return `${top.name} leads ${b.metric.toLowerCase()} at ${value} (p50, 24h) on ${b.title}.`;
}

/** Pasteable attribution string. Standard convention: "<sentence> Source: OpenChainBench (url)". */
export function citationQuote(b: Benchmark, origin: string): string {
  const sentence = headlineSentence(b);
  return `${sentence} Source: OpenChainBench (${origin}/benchmarks/${b.slug}).`;
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
