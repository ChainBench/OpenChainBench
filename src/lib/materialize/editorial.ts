/**
 * Editorial/draft helpers for materialize/load.
 *
 * Pure spec → Benchmark transforms that don't touch Prometheus. Used by
 * the live-load path (editorial scaffold) and by the per-bench cache
 * aggregator when a single bench fully fails (cold start + Prom blackout,
 * no previous cache to preserve): a draft placeholder so the page still
 * renders.
 */

import type { Benchmark, ProviderResult } from "@/types/benchmark";
import type { Spec } from "@/lib/spec-schema";

export function buildEditorial(
  spec: Spec,
): Omit<Benchmark, "results" | "extras" | "sampleSize" | "lastRunAt"> {
  return {
    slug: spec.slug,
    number: spec.number,
    title: spec.title,
    seoTitle: spec.seo_title,
    seoDescription: spec.seo_description,
    seoIntro: spec.seo_intro,
    disclaimer: spec.disclaimer,
    faq: spec.faq,
    perChainExplainer: spec.per_chain_explainer,
    subtitle: spec.subtitle,
    category: spec.category,
    status: spec.status,
    editorialStatus: spec.status,
    metric: spec.metric,
    unit: spec.unit,
    higherIsBetter: spec.higher_is_better,
    abstract: spec.abstract,
    methodology: spec.methodology,
    findings: spec.findings,
    source: spec.source,
    dimensions: spec.dimensions,
    ledgerColumns: spec.ledger_columns,
    expectedN: spec.expected_n,
  };
}

// Used by the per-bench cache aggregator when a single bench fully fails
// (cold start + Prom blackout, no previous cache to preserve). Renders a
// draft placeholder so the page still works.
export function draftPlaceholderForSpec(spec: Spec): Benchmark {
  return draftBenchmark(spec, buildEditorial(spec));
}

export function draftBenchmark(
  spec: Spec,
  editorial: Omit<Benchmark, "results" | "extras" | "sampleSize" | "lastRunAt">,
): Benchmark {
  // Render the page even when Prometheus has no data yet. the editorial
  // metadata is still useful, and the results section shows "awaiting first
  // run" so readers know what's happening.
  const results: ProviderResult[] = spec.providers.map((p) => ({
    name: p.name,
    slug: p.slug,
    tag: p.tag,
    type: p.type,
    layer: p.layer,
    ms: { p50: 0, p90: 0, p99: 0, mean: 0 },
    successRate: 0,
    secondary: p.secondary,
    formula: p.formula,
  }));
  return {
    ...editorial,
    status: "draft",
    results,
    extras: { series24h: {}, regions: {} },
    sampleSize: 0,
    lastRunAt: new Date().toISOString(),
  };
}
