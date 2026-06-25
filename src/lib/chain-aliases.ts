/**
 * Chain slug aliases. Extracted here (no external imports) so spec.ts
 * can resolve canonical slugs without pulling chains.ts which would
 * close a circular dependency with @/data/benchmarks → @/lib/spec.
 * That cycle caused a TDZ at build time on /alternatives OG image
 * routes (`Cannot access 'ec' before initialization`).
 *
 * Add a new alias when a chain rebrands; remove an alias once the
 * caches and harnesses have rotated past it.
 */
export const CHAIN_SLUG_ALIASES: Record<string, string> = {
  ton: "gram",
};

/** Map any slug to its canonical chain slug. Identity for known slugs,
 *  resolves a legacy slug to its current canonical via CHAIN_SLUG_ALIASES,
 *  returns the input lowercased for anything unknown. */
export function canonicalChainSlug(slug: string): string {
  const lc = slug.toLowerCase();
  return CHAIN_SLUG_ALIASES[lc] ?? lc;
}
