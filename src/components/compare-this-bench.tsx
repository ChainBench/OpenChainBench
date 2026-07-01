/**
 * Server-rendered contextual compare links on /benchmarks/[slug].
 *
 * The compare hub has 1,500+ ad-hoc /compare/<a>-vs-<b> pages seeded via
 * the sitemap, but each one had <2 inlinks (Ahref data 2026-06),
 * leaving Google to file them under "Indexed, not selected". Surfacing
 * 3-5 head-to-head pairs on the parent bench turns every bench page
 * into an internal PageRank source for its most relevant compare pages.
 *
 * Pairs are chosen from the top of the live ranking (#1v2, #1v3, #2v3,
 * #1v5, #2v4) so the link targets align with the queries Google
 * already sends to the bench (readers arrive on "best perp funding
 * stability" and immediately see "hyperliquid vs bybit").
 *
 * No-op when:
 *   - the bench category is Blockchains (chains have their own hubs)
 *   - fewer than 3 usable pairs can be built (skip HL builder hex
 *     slugs, dedupe canonical pairs)
 */

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { liveResults } from "@/lib/provider-filters";
import { rankResults } from "@/lib/ranking";
import { canonicalPairSlug } from "@/lib/compare-pairing-shared";
import type { Benchmark } from "@/types/benchmark";

// Mirror of the entry-side filter on /compare/[slug]/page.tsx. HL
// builder addresses leak into the provider catalog with no search
// demand, and compare pages built off them 404 anyway.
const HEX_SLUG_RE = /^0x[0-9a-f]{4,}$/i;

// #1v#2, #1v#3, #2v#3, #1v#5, #2v#4. Reads as "leader vs runner-up",
// "leader vs #3", ..., which is what a reader landing on the bench
// wants to compare. Order matters: the earlier a pair appears in
// this list, the earlier it renders on the page.
const PAIR_INDEX_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, 2],
  [1, 2],
  [0, 4],
  [1, 3],
];

const MIN_PAIRS = 3;

export function CompareThisBench({ benchmark }: { benchmark: Benchmark }) {
  // Blockchains category = chain-slug results. The hub for chains
  // already carries the "chain vs chain" story; keep those pages
  // out of the ad-hoc compare graph so we don't blur the two
  // discovery paths.
  if (benchmark.category === "Blockchains") return null;

  const live = liveResults(benchmark.results);
  const ranked = rankResults(live, benchmark.higherIsBetter).filter(
    (r) => !HEX_SLUG_RE.test(r.slug),
  );

  // Defensive dedupe by slug: some benches carry the same provider
  // across dimension rows before the loader collapses them.
  const seenSlugs = new Set<string>();
  const uniqueRanked = ranked.filter((r) => {
    const key = r.slug.toLowerCase();
    if (seenSlugs.has(key)) return false;
    seenSlugs.add(key);
    return true;
  });

  if (uniqueRanked.length < 3) return null;

  const seenPairs = new Set<string>();
  const pairs: { pairSlug: string; a: string; b: string }[] = [];
  for (const [i, j] of PAIR_INDEX_PATTERN) {
    const a = uniqueRanked[i];
    const b = uniqueRanked[j];
    if (!a || !b) continue;
    const pairSlug = canonicalPairSlug(a.slug, b.slug);
    if (seenPairs.has(pairSlug)) continue;
    seenPairs.add(pairSlug);
    pairs.push({ pairSlug, a: a.name, b: b.name });
  }

  if (pairs.length < MIN_PAIRS) return null;

  return (
    <nav className="mt-12 max-w-3xl" aria-label="Head to head comparisons">
      <h2 className="label-mono text-ink-muted">Head to head</h2>
      <p className="mt-2 text-sm text-ink-soft max-w-2xl">
        Side by side pages for the top providers on this benchmark. Each
        one lays out every shared benchmark, live numbers, no verdict.
      </p>
      <ul className="mt-4 flex flex-wrap gap-2">
        {pairs.map((p) => (
          <li key={p.pairSlug}>
            <Link
              href={`/compare/${p.pairSlug}`}
              className="inline-flex items-center gap-1.5 rounded-md card-soft px-3 py-1.5 text-sm text-ink-soft hover:text-ink"
            >
              <span>
                {p.a} vs {p.b}
              </span>
              <ArrowUpRight
                size={12}
                strokeWidth={2}
                className="shrink-0 text-ink-faint"
              />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
