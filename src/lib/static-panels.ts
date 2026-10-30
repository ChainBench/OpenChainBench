import type { Benchmark, LedgerColumn, MetricPanel } from "@/types/benchmark";

/** How many metric panels the server table carries when the spec names none.
 *  Three keeps the row readable at phone width next to the rank, name,
 *  headline and success columns; a bench with ten panels (perp-pf-ratio)
 *  would otherwise ship a table nobody can scan. */
export const MAX_STATIC_PANELS = 3;

/**
 * Which panels the crawler-facing table shows.
 *
 * A spec that declares `ledger_columns` has NAMED the table it publishes, so
 * that list wins over the first three panels in spec order.
 *
 * Bench 311 is why. Its title, H1 and meta description all promise trace,
 * archive and getLogs cells. Its first three panels are three getLogs
 * readings, and the third is the boolean its own spec comment says the window
 * columns replaced, so the served HTML contained the string trace_block zero
 * times. The audience that gets this table is the one that cannot run the
 * JavaScript which would have drawn the rest: GPTBot, OAI-SearchBot,
 * PerplexityBot and Claude-User, all of them allowed by robots.txt (SEO audit
 * 2026-10-30, blocker 1).
 *
 * A declared column whose panel has no values is dropped rather than rendered
 * empty, and a spec that declares no columns keeps the three-panel rule. The
 * schema caps the declared list at nine, so the table's width stays bounded
 * by a human decision instead of by the constant above.
 *
 * Extracted from the component so the choice can be tested on its own. The
 * component needs a whole Benchmark and a React tree, and the rule is what is
 * worth pinning.
 */
export function staticLedgerPanels(
  metricPanels: MetricPanel[] | undefined,
  ledgerColumns: LedgerColumn[] | undefined,
): MetricPanel[] {
  const withValues = (metricPanels ?? []).filter(
    (p) => p.values && Object.keys(p.values).length > 0,
  );
  const declared = (ledgerColumns ?? [])
    .map((c) => c.panel)
    .filter((id): id is string => Boolean(id))
    .map((id) => withValues.find((p) => p.id === id))
    .filter((p): p is MetricPanel => p !== undefined);
  return declared.length > 0 ? declared : withValues.slice(0, MAX_STATIC_PANELS);
}

/** Convenience for the component, which holds the whole benchmark. */
export function panelsForStaticLedger(benchmark: Benchmark): MetricPanel[] {
  return staticLedgerPanels(benchmark.metricPanels, benchmark.ledgerColumns);
}
