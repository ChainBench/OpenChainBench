/**
 * Shared types and pure utility shared between the server-only
 * `compare-pairing.ts` (which depends on getProviders + ioredis) and
 * the client-only `compare-selector.tsx`. Keeping these here avoids
 * pulling the full provider loader (and its transitive ioredis import)
 * into the client bundle.
 */

export type CompareCandidate = {
  slug: string;
  name: string;
};

/** Canonical slug for a head to head pair. Forces alphabetical order
 *  so /compare/a-vs-b is the same as /compare/b-vs-a from the URL side. */
export function canonicalPairSlug(a: string, b: string): string {
  const [first, second] = [a, b].sort();
  return `${first}-vs-${second}`;
}
