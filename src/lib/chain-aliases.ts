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
