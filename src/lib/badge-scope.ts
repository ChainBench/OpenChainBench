/**
 * What a scoped badge request may honestly serve, and under which label.
 *
 * The badge prints a figure and, next to it, the scope that figure was
 * earned on. Those two must come from the same decision. They did not:
 * `?chain=<x>` on a bench without a `rank_matrix_query` fell through to a
 * per-chain approximation that forced the chain's leader to rank 1 and
 * read everybody else's UNFILTERED median, then printed the chain's label
 * over it. Measured on production, 2026-10-29:
 *
 *   /api/badge/perp-fees/hyperliquid            #6/11 (all chains) 0.048%
 *   /api/badge/perp-fees/hyperliquid?chain=ETH  #6/11 (ETH)        0.048%
 *   /api/badge/perp-fees/hyperliquid?chain=BTC  #6/11 (BTC)        0.048%
 *   /api/badge/perp-fees/hyperliquid?chain=SOL  #6/11 (SOL)        0.048%
 *
 * One figure under four labels, three of which it does not have. Twenty
 * live chain-dimensioned benches declare no `rank_matrix_query`, so this
 * was the normal path rather than an edge case.
 *
 * The rule here is that a scope label is only ever printed over a figure
 * measured in that scope. When the scope cannot be ranked there are two
 * honest answers and which one applies depends on what was asked:
 *
 *  - a chain alone: the bench still has a real cross-chain ranking, so
 *    serve that and say so. The label is how the embedder sees their
 *    `?chain=` was not honoured.
 *  - a region, with or without a chain: there is no coarser figure to
 *    stand in (regions are not an aggregate of anything the bench ranks),
 *    so withhold and claim no rank at all.
 *
 * Returning the label together with the figure, rather than letting the
 * caller assemble it, is deliberate: the fault was a label and a figure
 * chosen in two different places.
 */

export type RankPoint = { rank: number; total: number; value: number };

export type BadgeScope =
  /** The exact cell was ranked. Label names the requested scope. */
  | { serve: "cell"; rank: RankPoint; scopeLabel: string }
  /** Serve the bench's unfiltered ranking, labelled as the aggregate. */
  | { serve: "aggregate"; scopeLabel: string }
  /** No defensible position: the caller withholds the rank entirely. */
  | { serve: "withhold" };

export type BadgeScopeInput = {
  /** Canonical dimension values, already validated by the caller. */
  chain: string | null;
  region: string | null;
  /** The exact per-cell rank, when the bench has one for this cell. */
  cell: RankPoint | null;
  chainLabel: (chain: string) => string;
  regionLabel: (region: string) => string;
  /** Whether the bench declares the dimension at all (beyond "all"), which
   *  is what makes an "all chains" / "all regions" hint meaningful. */
  hasChainDimension: boolean;
  hasRegionDimension: boolean;
  /** Access-tier cohort label, when the request swapped the cohort. */
  cohortLabel: string | null;
  /** The slice an unfiltered rank was earned on for benches ranked per
   *  profile, volume or plan band. Aggregate label only: "#1" alone reads
   *  as overall. */
  defaultViewLabel: string | null;
};

function join(parts: (string | null)[]): string {
  return parts.filter(Boolean).join(" · ");
}

export function resolveBadgeScope(input: BadgeScopeInput): BadgeScope {
  const { chain, region, cell } = input;
  if (cell) {
    return {
      serve: "cell",
      rank: cell,
      scopeLabel: join([
        chain ? input.chainLabel(chain) : null,
        region ? input.regionLabel(region) : null,
        input.cohortLabel,
      ]),
    };
  }
  // A region was asked for and could not be ranked. The aggregate is not a
  // stand-in for it: "all regions" answers a question nobody asked, and the
  // figure would be a blend of the very regions the reader wanted to
  // compare.
  if (region) return { serve: "withhold" };
  return {
    serve: "aggregate",
    scopeLabel: join([
      input.hasChainDimension ? "all chains" : null,
      input.hasRegionDimension ? "all regions" : null,
      input.cohortLabel,
      input.defaultViewLabel,
    ]),
  };
}
