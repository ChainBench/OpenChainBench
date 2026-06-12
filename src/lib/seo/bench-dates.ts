import publishedMap from "@/data/bench-published.json";

/**
 * Static `datePublished` lookup per bench. The map is generated locally
 * via `scripts/generate-bench-published.mjs` (which runs `git log
 * --diff-filter=A` against each YAML) and committed to the repo. We can
 * NOT compute this at build time on Vercel — Vercel does a shallow
 * `git clone --depth=1` so the first-add commit isn't present in the
 * build container's git history.
 *
 * Why this matters: JSON-LD `datePublished` must be a stable date per
 * bench (the day the page first existed), distinct from `dateModified`
 * (which moves with every harness scrape). When `datePublished` is
 * missing or equal to `dateModified`, Google's freshness pipeline reads
 * the URL as "appeared today, churns daily" and downranks it.
 *
 * Regenerate when adding a new bench:
 *   node scripts/generate-bench-published.mjs
 */

const FLOOR_PUBLISHED = new Date("2025-01-01T00:00:00Z");
const map = publishedMap as Record<string, string>;

export function getBenchCreatedAt(slug: string): Date {
  const iso = map[slug];
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return FLOOR_PUBLISHED;
}
