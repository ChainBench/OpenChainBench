import { execSync } from "node:child_process";

/**
 * Build-time lookup of a bench's first-publish date via git history.
 *
 * Why: JSON-LD `datePublished` must be a stable date per bench (the day
 * the page first existed), distinct from `dateModified` (which moves with
 * every harness scrape). When `datePublished` is missing or equal to
 * `dateModified`, Google's freshness pipeline treats the URL as
 * "appeared today, churns daily" and downranks it.
 *
 * The first commit that added `benchmarks/<slug>.yml` is the authoritative
 * publish moment. We resolve it via `git log --diff-filter=A` at module
 * load (Vercel build container has the .git tree), cache per slug, and
 * fall back to a fixed floor if git is unavailable (local dev outside the
 * repo, or a corrupt clone).
 *
 * `execSync` is acceptable here because:
 *   - This runs at build time (or first warm hit) on a long-lived ISR
 *     page, not on every request.
 *   - The result is memoised in module scope so repeated calls cost zero.
 */

const FLOOR_PUBLISHED = new Date("2025-01-01T00:00:00Z");
const cache = new Map<string, Date>();

export function getBenchCreatedAt(slug: string): Date {
  const cached = cache.get(slug);
  if (cached) return cached;
  try {
    const out = execSync(
      `git log --diff-filter=A --format=%cI --reverse -- "benchmarks/${slug}.yml" | head -n 1`,
      { encoding: "utf8", cwd: process.cwd(), timeout: 5000 },
    ).trim();
    if (out) {
      const d = new Date(out);
      if (!Number.isNaN(d.getTime())) {
        cache.set(slug, d);
        return d;
      }
    }
  } catch {
    /* fall through */
  }
  cache.set(slug, FLOOR_PUBLISHED);
  return FLOOR_PUBLISHED;
}
