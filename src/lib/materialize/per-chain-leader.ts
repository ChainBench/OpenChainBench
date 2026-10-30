/**
 * Who, if anyone, leads a chain.
 *
 * `bestPerChain` feeds the "#1 of N on <chain>" chip on product pages. It was
 * `sorted[0]` of every live row, which gets two things wrong and the
 * adversarial audit of bench 311 found both on the live site.
 *
 * A GATED ROW WAS CROWNED. Alchemy is published unranked on the Robinhood tab
 * of bench 311, with its cause printed next to it, because the one method it
 * was not asked is the one the rest of the cohort refuses. The leader stash
 * does not read `unrankedLabel`, so /products/alchemy rendered "#1 of 5 on
 * Robinhood Chain" while the board itself declined to rank the row. The 5 is
 * the gated pool, which does not include Alchemy, so even the denominator
 * described a different set from the numerator.
 *
 * A TIE WAS BROKEN BY YAML ORDER. On Ethereum, Quicknode, Chainstack, Dwellir
 * and BlockMachine all read 100. The sort is stable, so first-in-the-spec won
 * and /products/quicknode claimed "#1 of 5" on five chains while three equal
 * providers got nothing. A tie is not a ranking, and this repo spent the year
 * removing that shape from boards; a chip is the same claim in a smaller box.
 *
 * So: a row the board publishes outside its ranking cannot lead, and a shared
 * top value elects nobody. The conservative answer is no chip rather than a
 * chip someone else has an equal right to.
 */

/** The fields this rule reads. Deliberately narrow so the test does not have
 *  to build a whole ProviderResult. */
export type LeaderCandidate = {
  slug: string;
  ms: { p50: number };
  /** Set by the loader when the board publishes the row outside its ranking,
   *  with the reason it prints beside it. */
  unrankedLabel?: string;
};

/**
 * Pick the leader of one chain, or none.
 *
 * Returns null when nothing qualifies, when every candidate is gated, or when
 * the best value is shared. Ties are compared on the exact stored value: these
 * are aggregates of the same query over the same window, so two providers that
 * genuinely differ do not collide here, and two that collide are not separable
 * by anything this chip could show.
 */
export function pickChainLeader<T extends LeaderCandidate>(
  candidates: readonly T[],
  higherIsBetter: boolean,
): T | null {
  const eligible = candidates.filter((c) => !c.unrankedLabel);
  if (eligible.length === 0) return null;
  const sorted = [...eligible].sort((a, b) =>
    higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
  );
  const best = sorted[0];
  if (sorted.length > 1 && sorted[1].ms.p50 === best.ms.p50) return null;
  return best;
}

/**
 * The other end of the same board. A trailer carries no claim of merit, so a
 * tie there is harmless, but a gated row must not be named the worst either:
 * being unranked is a statement about comparability, and the chip would read
 * as a verdict.
 */
export function pickChainTrailer<T extends LeaderCandidate>(
  candidates: readonly T[],
  higherIsBetter: boolean,
): T | null {
  const eligible = candidates.filter((c) => !c.unrankedLabel);
  if (eligible.length === 0) return null;
  const sorted = [...eligible].sort((a, b) =>
    higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
  );
  return sorted[sorted.length - 1];
}
