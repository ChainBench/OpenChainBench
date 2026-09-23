/**
 * What one row of a bench IS, in words.
 *
 * Most OCB benches rank providers, so "provider" is the default and always
 * was hardcoded. It is wrong wherever the rows are something else: bench
 * 273's board is chains, l1-finality's is chains, and the sentence the page
 * marks for an answer engine to quote read "across 41 ranked providers"
 * about a list of blockchains (SEO audit 2026-09-23).
 *
 * The noun reaches the quotable TL;DR, the StatisticalReport JSON-LD,
 * /api/stat, /api/citable, llms.txt, the Results heading, the table caption
 * and the infobox, so it goes through one helper rather than being spelled
 * at each site: a bench that sets `row_noun` must read consistently
 * everywhere, or a reader sees "chains" in the heading and "providers" in
 * the quote.
 */
export type RowNoun = { one: string; many: string };

const DEFAULT_ROW_NOUN: RowNoun = { one: "provider", many: "providers" };

export function rowNoun(b: { rowNoun?: RowNoun } | null | undefined): RowNoun {
  return b?.rowNoun ?? DEFAULT_ROW_NOUN;
}

/** "1 chain" / "41 chains", with the count. */
export function countRows(
  b: { rowNoun?: RowNoun } | null | undefined,
  n: number,
): string {
  const noun = rowNoun(b);
  return `${n} ${n === 1 ? noun.one : noun.many}`;
}

/** Just the noun, agreeing with n. */
export function nounFor(
  b: { rowNoun?: RowNoun } | null | undefined,
  n: number,
): string {
  const noun = rowNoun(b);
  return n === 1 ? noun.one : noun.many;
}

/** Title-case for a column header or an infobox label: "Providers". */
export function nounLabel(b: { rowNoun?: RowNoun } | null | undefined): string {
  const many = rowNoun(b).many;
  return many.charAt(0).toUpperCase() + many.slice(1);
}
