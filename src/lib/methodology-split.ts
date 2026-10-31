/**
 * Where to cut a long methodology so the results are not buried.
 *
 * A text extractor and an answer engine read in DOM order, and the bench page
 * renders the whole methodology before the board. Measured on bench 311
 * (2026-10-30), word offsets in the served HTML: H1 at 94, the Methodology
 * heading at 274, the Results heading at 1,986, the FAQ at 2,147, out of
 * 2,898. Its methodology is 1,614 words, the fourth longest of 261 specs, so
 * a crawler met roughly 1,900 words of method before the first row of the
 * table it came to cite.
 *
 * Closing the existing `<details>` would not help: the text stays ahead of
 * the table either way. So the bullets are split, not shortened. The lead
 * bullets carry the thesis and stay above the board, which keeps "the method
 * before the numbers"; the remainder moves below it.
 *
 * Only long methodologies are touched. 17 of 261 specs are over the
 * threshold; the other 244 keep every bullet in one place and render exactly
 * as before.
 */

/** Above this many words, a methodology is split. */
export const METHODOLOGY_SPLIT_WORDS = 600;

/** How many bullets stay above the board when it is. */
export const METHODOLOGY_LEAD_BULLETS = 3;

export type MethodologySplit = {
  /** Rendered in the Methodology section, above the board. */
  lead: string[];
  /** Rendered in a closed block below the board. Empty when no split. */
  notes: string[];
};

export function splitMethodology(
  bullets: string[] | undefined,
  splitWords: number = METHODOLOGY_SPLIT_WORDS,
): MethodologySplit {
  const all = bullets ?? [];
  const words = all.join(" ").trim().split(/\s+/).filter(Boolean).length;
  if (words <= splitWords || all.length <= METHODOLOGY_LEAD_BULLETS) {
    return { lead: all, notes: [] };
  }
  return {
    lead: all.slice(0, METHODOLOGY_LEAD_BULLETS),
    notes: all.slice(METHODOLOGY_LEAD_BULLETS),
  };
}
