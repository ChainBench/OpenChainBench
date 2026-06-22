/**
 * Citation helpers shared between the JSON API and the UI buttons. Single
 * source of truth for the headline sentence and quote string that
 * everyone (LLMs, journalists, ourselves) sees.
 */

import type { Benchmark } from "@/types/benchmark";
import { liveResults } from "@/lib/provider-filters";
import { fmtUnit } from "@/lib/format";

/**
 * Canonical "this bench cannot be ranked right now" predicate, shared by
 * every citable surface (api/stat, api/citable, api/llm-context, llms.txt,
 * /answers, bench page hero, OG image, MCP).
 *
 * A benchmark is insufficient when ANY of:
 *  - editorialStatus is draft (the spec author has not published)
 *  - runtime status flipped to draft (the materialize layer fell back to
 *    draftPlaceholderForSpec because every Prom query came back empty)
 *  - aggregate sampleSize is exactly 0 (harness ran but emitted no
 *    samples; the headline number is then a rolling aggregate over an
 *    empty window and must not be cited)
 *  - no live provider has a usable, finite, positive p50
 *
 * Why both bench.sampleSize and the per-provider p50 check matter:
 *  /api/stat goes through the per-slug cache and routinely returns
 *  status=live with a non-zero p50 even when the aggregator collapsed
 *  the same bench to draft on /api/citable (per-bench throw, fallback
 *  to draftPlaceholderForSpec). Aligning on bench.sampleSize === 0
 *  closes that gap for the network-fees / token-deployment-cost class
 *  of bench, where the harness emits a value but no samples.
 *
 * Notes:
 *  - per-provider `sampleSize` is intentionally NOT used. Several
 *    harnesses do not emit a per-provider count even when the rolling
 *    headline is real, so making it a hard condition would mass-flag
 *    healthy benches.
 *  - Use this predicate BEFORE deriving leader / fieldValue / headline
 *    for any externally-visible surface.
 */
export function isInsufficient(b: Benchmark): boolean {
  if (b.editorialStatus !== "live") return true;
  if (b.status !== "live") return true;
  if (b.sampleSize === 0) return true;
  const live = liveResults(b.results);
  if (live.length === 0) return true;
  return live.every((r) => !Number.isFinite(r.ms.p50) || r.ms.p50 <= 0);
}

/** Median value of the benchmark (the field shown in the headline). */
export function fieldValue(b: Benchmark): number | null {
  if (isInsufficient(b)) return null;
  const live = liveResults(b.results);
  if (live.length === 0) return null;
  const sorted = [...live].sort((a, c) =>
    b.higherIsBetter ? c.ms.p50 - a.ms.p50 : a.ms.p50 - c.ms.p50
  );
  return sorted[0].ms.p50;
}

/** Who is currently #1 on this benchmark, if any. */
export function leader(b: Benchmark): { name: string; slug: string; value: number } | null {
  if (isInsufficient(b)) return null;
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
export function windowSuffix(unit: string): string {
  if (unit === "usd" || unit === "count") return "(24h)";
  if (unit === "pct" || unit === "bps") return "(24h avg)";
  return "(p50, 24h)";
}

/** Short factual sentence ready to paste into an article. Templated, no LLM.
 *
 *  Three-state output, in priority order:
 *    1. Insufficient data: harness has no usable sample (zero p50 across
 *       every provider, draft status, etc). Refuse to assert a winner.
 *    2. No provider but bench is live (transient edge case): generic
 *       "awaiting first run" sentence.
 *    3. Live with a leader: the standard headline assertion.
 *
 *  The insufficient branch is critical for /answers, /llms.txt,
 *  /api/llm-context and /api/citable so an LLM consumer never reads a
 *  fabricated leader for a bench whose harness has not produced data. */
export function headlineSentence(b: Benchmark): string {
  if (isInsufficient(b)) {
    return `Insufficient data to rank providers. The harness for ${b.title} is awaiting sufficient samples.`;
  }
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
