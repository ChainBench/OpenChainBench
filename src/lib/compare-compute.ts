/**
 * Pure data-composition helpers for the /compare/[slug] page.
 *
 * Extracted from `src/app/compare/[slug]/page.tsx` so the route can
 * focus on data fetching + JSX while the head-to-head computation lives
 * in a single, unit-testable module. No React, no fetch, no `unstable_cache`.
 * All inputs are plain values (Benchmark / Provider appearances) and
 * outputs are plain objects.
 */

import { loadBenchmark } from "@/lib/spec";
import {
  computeInputsHash,
  readPairCache,
  writePairCache,
} from "@/lib/compare-cache";
import { nonAllValues } from "@/lib/dimensions";
import type { ComparePair } from "@/data/compare-pairs";
import type { getProvider } from "@/lib/providers";
import type { Benchmark } from "@/types/benchmark";

export { nonAllValues };

export type Panel = {
  rank: number;
  p50: number;
  p99: number;
  sampleSize?: number;
};

export type BreakdownRow = {
  value: string;
  label: string;
  aP50: number;
  bP50: number;
  aWins: boolean;
  bWins: boolean;
};

/** One chain entry inside a chain x region matrix. Carries the chain
 *  aggregate row plus the per region sub-rows scoped to that chain.
 *  Rendered as two side by side rows (one per provider) with a column
 *  per region plus the chain aggregate column on the right. */
export type ChainRegionEntry = BreakdownRow & {
  regionRows: BreakdownRow[];
};

export type SharedBench = {
  slug: string;
  title: string;
  category: Benchmark["category"];
  unit: Benchmark["unit"];
  metric: string;
  higherIsBetter: boolean;
  lastRunAt: Benchmark["lastRunAt"];
  aResult: Panel;
  bResult: Panel;
  /** Aggregate winner side. "tie" when p50 are equal. */
  aggregateWinner: "a" | "b" | "tie";
  /** Per chain side by side rows, populated only for benches with
   *  `dimensions.chain` and where both providers have positive p50 in
   *  the filtered variant. */
  chainBreakdown: BreakdownRow[];
  /** Per region side by side rows, same gating as chainBreakdown. */
  regionBreakdown: BreakdownRow[];
  /** Chain x region matrix, populated only for benches that expose
   *  BOTH `dimensions.chain` and `dimensions.region`. When present, the
   *  renderer uses this nested structure as a single 2D table and
   *  drops the flat chainBreakdown + regionBreakdown so we don't stack
   *  three tables for the same data. */
  chainRegionMatrix: ChainRegionEntry[];
};

/** Dimension option shape used by Benchmark.dimensions.* */
type DimensionOption = { value: string; label: string };

/** Reduce a list of items to the most recent ISO timestamp.
 *  `pick(item)` returns the candidate ISO string (or null/undefined to skip).
 *  Returns null when no item provides a timestamp. Used for the "Last
 *  measured" badge in the page header. */
export function latestIso<T>(
  items: readonly T[],
  pick: (item: T) => string | null | undefined,
): string | null {
  return items.reduce<string | null>((acc, item) => {
    const ts = pick(item);
    if (!ts) return acc;
    if (!acc || new Date(ts) > new Date(acc)) return ts;
    return acc;
  }, null);
}

/** Format an ISO timestamp as a UTC display string (e.g.
 *  `Tue, 17 Jun 2026 14:23:00 UTC`). Returns null for missing input so
 *  the caller can skip the surrounding markup. */
export function fmtTs(iso?: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toUTCString().replace("GMT", "UTC");
}

/** Sort comparator that respects `higherIsBetter`. Returns:
 *    "a" if A leads, "b" if B leads, "tie" if both equal. */
export function decideWinner(
  aP50: number,
  bP50: number,
  higherIsBetter: boolean,
): "a" | "b" | "tie" {
  if (aP50 === bP50) return "tie";
  if (higherIsBetter) return aP50 > bP50 ? "a" : "b";
  return aP50 < bP50 ? "a" : "b";
}

/** Load the per-dimension breakdown for one shared bench against one
 *  axis. Resolves each dimension value to a filtered Benchmark via
 *  loadBenchmark, then picks both providers' results. Drops rows where
 *  either provider lacks live data so we never render "0 vs 0" panels. */
export async function loadBreakdown(
  benchSlug: string,
  axis: "chain" | "region",
  options: DimensionOption[],
  providerA: string,
  providerB: string,
  higherIsBetter: boolean,
): Promise<BreakdownRow[]> {
  const filtered = nonAllValues(options);
  if (filtered.length === 0) return [];
  const rows = await Promise.all(
    filtered.map(async (opt) => {
      const variant = await loadBenchmark(benchSlug, {
        [axis]: opt.value,
      });
      if (!variant) return null;
      const aRes = variant.results.find((r) => r.slug === providerA);
      const bRes = variant.results.find((r) => r.slug === providerB);
      if (!aRes || !bRes) return null;
      if (aRes.ms.p50 <= 0 || bRes.ms.p50 <= 0) return null;
      const winner = decideWinner(aRes.ms.p50, bRes.ms.p50, higherIsBetter);
      return {
        value: opt.value,
        label: opt.label,
        aP50: aRes.ms.p50,
        bP50: bRes.ms.p50,
        aWins: winner === "a",
        bWins: winner === "b",
      } satisfies BreakdownRow;
    }),
  );
  return rows.filter((r): r is BreakdownRow => r !== null);
}

/** Loads a chain x region matrix for one bench, scoped to the two
 *  providers. For each chain value (excluding "all"), we load the
 *  chain aggregate AND every region variant within that chain via the
 *  combined `{ chain, region }` filter. Rows where either provider has
 *  no live data are dropped at every level so the rendered table never
 *  surfaces "0 vs 0" cells. Returns [] when either dimension is empty.
 *
 *  Fan out shape: every chain aggregate AND every (chain, region) tuple
 *  is dispatched in the same tick via one flat Promise.all. The previous
 *  shape awaited each chain aggregate before kicking off its region
 *  children, which serialised one extra round trip per chain on top of
 *  the actual fan out. With three chains x three regions that was
 *  roughly 500 ms to 1 s of avoidable wall clock on a cold ad hoc pair.
 */
export async function loadChainRegionMatrix(
  benchSlug: string,
  chainOpts: DimensionOption[],
  regionOpts: DimensionOption[],
  providerA: string,
  providerB: string,
  higherIsBetter: boolean,
): Promise<ChainRegionEntry[]> {
  const chains = nonAllValues(chainOpts);
  const regions = nonAllValues(regionOpts);
  if (chains.length === 0 || regions.length === 0) return [];

  const chainTasks = chains.map((c) =>
    loadBenchmark(benchSlug, { chain: c.value }),
  );
  const regionTasks = chains.flatMap((c) =>
    regions.map((r) =>
      loadBenchmark(benchSlug, {
        chain: c.value,
        region: r.value,
      }).then((variant) => ({ chain: c.value, region: r.value, variant })),
    ),
  );
  const [chainVariants, regionVariants] = await Promise.all([
    Promise.all(chainTasks),
    Promise.all(regionTasks),
  ]);

  // Group region results by chain. Insertion order matches `chains` then
  // `regions` because flatMap walks in that order and Promise.all
  // preserves index order, so the rendered table keeps its column order.
  const regionsByChain = new Map<string, typeof regionVariants>();
  for (const rv of regionVariants) {
    const list = regionsByChain.get(rv.chain) ?? [];
    list.push(rv);
    regionsByChain.set(rv.chain, list);
  }

  const entries: ChainRegionEntry[] = [];
  for (let i = 0; i < chains.length; i += 1) {
    const c = chains[i];
    const chainVariant = chainVariants[i];
    if (!chainVariant) continue;
    const aChain = chainVariant.results.find((r) => r.slug === providerA);
    const bChain = chainVariant.results.find((r) => r.slug === providerB);
    if (!aChain || !bChain) continue;
    if (aChain.ms.p50 <= 0 || bChain.ms.p50 <= 0) continue;
    const chainWinner = decideWinner(
      aChain.ms.p50,
      bChain.ms.p50,
      higherIsBetter,
    );

    const regionRows: BreakdownRow[] = [];
    for (const rv of regionsByChain.get(c.value) ?? []) {
      if (!rv.variant) continue;
      const aRes = rv.variant.results.find((x) => x.slug === providerA);
      const bRes = rv.variant.results.find((x) => x.slug === providerB);
      if (!aRes || !bRes) continue;
      if (aRes.ms.p50 <= 0 || bRes.ms.p50 <= 0) continue;
      const regionMeta = regions.find((r) => r.value === rv.region);
      if (!regionMeta) continue;
      const winner = decideWinner(aRes.ms.p50, bRes.ms.p50, higherIsBetter);
      regionRows.push({
        value: regionMeta.value,
        label: regionMeta.label,
        aP50: aRes.ms.p50,
        bP50: bRes.ms.p50,
        aWins: winner === "a",
        bWins: winner === "b",
      });
    }

    entries.push({
      value: c.value,
      label: c.label,
      aP50: aChain.ms.p50,
      bP50: bChain.ms.p50,
      aWins: chainWinner === "a",
      bWins: chainWinner === "b",
      regionRows,
    });
  }
  return entries;
}

/** Resolves the intersection of two providers' bench appearances, then
 *  enriches each shared bench with aggregate + per chain + per region
 *  breakdowns. Honors the pair's `benchmarks` whitelist (when set) and
 *  `excludeBenchmarks` blacklist. */
export async function buildSharedBenches(
  pair: ComparePair,
  aAppearances: Awaited<ReturnType<typeof getProvider>>,
  bAppearances: Awaited<ReturnType<typeof getProvider>>,
): Promise<SharedBench[]> {
  if (!aAppearances || !bAppearances) return [];

  const aByBench = new Map(
    aAppearances.appearances.map((x) => [x.benchmark.slug, x] as const),
  );
  const bByBench = new Map(
    bAppearances.appearances.map((x) => [x.benchmark.slug, x] as const),
  );

  // Bench selection order:
  //   1. If `benchmarks` whitelist is set, take that list as the
  //      candidate set (legacy editorial pin).
  //   2. Otherwise take the natural intersection of both providers'
  //      appearances (the default for any new pair).
  //   3. In both cases, subtract anything in `excludeBenchmarks`.
  const candidateSlugs = pair.benchmarks
    ? pair.benchmarks.filter((s) => aByBench.has(s) && bByBench.has(s))
    : Array.from(aByBench.keys()).filter((s) => bByBench.has(s));
  const excluded = new Set(pair.excludeBenchmarks ?? []);
  const sharedSlugs = candidateSlugs.filter((s) => !excluded.has(s));

  // KV cache lookup before the fan out. Hash mixes provider slugs, the
  // shared bench list and the deploy SHA so any drift (new bench, new
  // appearance, new deploy) auto invalidates. Returns null on any
  // failure path so the build below is always reachable.
  const inputsHash = computeInputsHash({
    providerA: aAppearances.slug,
    providerB: bAppearances.slug,
    benchSlugs: sharedSlugs,
  });
  const cached = await readPairCache<SharedBench>(pair.slug, inputsHash);
  if (cached) return cached;

  const built = await Promise.all(
    sharedSlugs.map(async (benchSlug) => {
      const aEntry = aByBench.get(benchSlug);
      const bEntry = bByBench.get(benchSlug);
      if (!aEntry || !bEntry) return null;
      const fullBench = await loadBenchmark(benchSlug);
      if (!fullBench) return null;

      const higherIsBetter = fullBench.higherIsBetter === true;
      const aPanel: Panel = {
        rank: aEntry.rank,
        p50: aEntry.result.ms.p50,
        p99: aEntry.result.ms.p99,
        sampleSize: aEntry.result.sampleSize,
      };
      const bPanel: Panel = {
        rank: bEntry.rank,
        p50: bEntry.result.ms.p50,
        p99: bEntry.result.ms.p99,
        sampleSize: bEntry.result.sampleSize,
      };
      const aggregateWinner = decideWinner(
        aPanel.p50,
        bPanel.p50,
        higherIsBetter,
      );

      const chainOpts = fullBench.dimensions?.chain ?? [];
      const regionOpts = fullBench.dimensions?.region ?? [];
      const hasBothDims =
        nonAllValues(chainOpts).length > 0 &&
        nonAllValues(regionOpts).length > 0;

      const [chainBreakdown, regionBreakdown, chainRegionMatrix] =
        await Promise.all([
          // When both dimensions exist the renderer uses the nested
          // matrix; skip the flat chain breakdown so we don't double
          // fetch.
          hasBothDims
            ? Promise.resolve<BreakdownRow[]>([])
            : loadBreakdown(
                benchSlug,
                "chain",
                chainOpts,
                aAppearances.slug,
                bAppearances.slug,
                higherIsBetter,
              ),
          hasBothDims
            ? Promise.resolve<BreakdownRow[]>([])
            : loadBreakdown(
                benchSlug,
                "region",
                regionOpts,
                aAppearances.slug,
                bAppearances.slug,
                higherIsBetter,
              ),
          hasBothDims
            ? loadChainRegionMatrix(
                benchSlug,
                chainOpts,
                regionOpts,
                aAppearances.slug,
                bAppearances.slug,
                higherIsBetter,
              )
            : Promise.resolve<ChainRegionEntry[]>([]),
        ]);

      return {
        slug: fullBench.slug,
        title: fullBench.title,
        category: fullBench.category,
        unit: fullBench.unit,
        metric: fullBench.metric,
        higherIsBetter,
        lastRunAt: fullBench.lastRunAt,
        aResult: aPanel,
        bResult: bPanel,
        aggregateWinner,
        chainRegionMatrix,
        chainBreakdown,
        regionBreakdown,
      } satisfies SharedBench;
    }),
  );
  const result = built.filter((b): b is SharedBench => b !== null);
  // Write the freshly built result back to KV via `after()` so the
  // response isn't blocked. Subsequent visitors within the TTL window
  // skip the entire fan out above.
  writePairCache(pair.slug, inputsHash, result);
  return result;
}

/** Split a `<a>-vs-<b>` slug. Provider slugs can themselves contain
 *  hyphens (`helius-sender`, `phantom-perps`, etc.), so we split on the
 *  exact `-vs-` delimiter, not on `-`. Returns null when the delimiter
 *  is missing or either side is empty. */
export function parseAdHocSlug(
  slug: string,
): { a: string; b: string } | null {
  const idx = slug.indexOf("-vs-");
  if (idx <= 0) return null;
  const a = slug.slice(0, idx);
  const b = slug.slice(idx + "-vs-".length);
  if (!a || !b || a === b) return null;
  return { a, b };
}

/** If the URL slug is `<a>-vs-<b>` but not alphabetical, return the
 *  canonical form so the route layer can redirect. Keeps a single
 *  canonical URL per pair from Google's perspective and matches the
 *  selector's `canonicalPairSlug` output. Returns null when the slug is
 *  already canonical or not a valid pair shape. */
export function canonicalisationTarget(slug: string): string | null {
  const parsed = parseAdHocSlug(slug);
  if (!parsed) return null;
  const [first, second] = [parsed.a, parsed.b].sort();
  const canonical = `${first}-vs-${second}`;
  return canonical === slug ? null : canonical;
}
