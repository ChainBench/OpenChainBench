/**
 * Chain-slug alias helpers, isolated from the chain registry so that
 * `src/lib/spec.ts` can import them without pulling in the registry's
 * data-layer dependency (`@/data/benchmarks` → `@/lib/spec` is a cycle
 * that fails with a TDZ "Cannot access 'X' before initialization"
 * crash at build time when both modules touch each other during ESM
 * evaluation).
 *
 * Used during chain rebrand transitions (e.g. TON → Gram, June 2026)
 * where stored snapshots + harness Prom labels still carry the legacy
 * slug while the YAMLs + chain registry have moved to the canonical
 * one. The site reads through these helpers to absorb the lag.
 *
 * Add an alias when a chain rebrands; remove an alias once the caches
 * and harnesses have rotated past it.
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

/** Returns every legacy slug that aliases to the given canonical, plus
 *  the canonical itself. Use as a Set when filtering YAML dimensions /
 *  result rows whose slug may still be in legacy form. */
export function chainSlugSiblings(slug: string): Set<string> {
  const canon = canonicalChainSlug(slug);
  const set = new Set<string>([canon]);
  for (const [legacy, target] of Object.entries(CHAIN_SLUG_ALIASES)) {
    if (target === canon) set.add(legacy);
  }
  return set;
}

/** True when two slugs refer to the same chain — either both canonical,
 *  one legacy that aliases to the other, or both legacy mapping to the
 *  same canonical. The canonical chain-comparison helper used at every
 *  site that previously did `=== chain` (route handlers, OG generators,
 *  badge API, sitemap filters, etc.). Case-insensitive. Both args are
 *  optional so callers with `string | null` URL params can pass without
 *  an inline guard. */
export function matchesChainSlug(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return canonicalChainSlug(a) === canonicalChainSlug(b);
}
