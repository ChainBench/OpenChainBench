import type { Metadata } from "next";
import { Fragment } from "react";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { getProvider } from "@/lib/providers";
import { loadBenchmark } from "@/lib/spec";
import {
  getComparePair,
  getComparePairSlugs,
  type ComparePair,
} from "@/data/compare-pairs";
import { getProviderRegistry } from "@/data/provider-registry";
import { ProviderLogo } from "@/components/provider-logo";
import { fmtUnit, fmtValue, unitSuffix } from "@/lib/format";
import { capDescription } from "@/lib/seo-text";
import { Breadcrumb } from "@/components/breadcrumb";
import { buildBreadcrumbJsonLd, safeJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { CREATOR_PUBLISHER, DATASET_LICENSE } from "@/lib/dataset-jsonld";
import type { Benchmark } from "@/types/benchmark";
import {
  computeInputsHash,
  readPairCache,
  writePairCache,
} from "@/lib/compare-cache";

/**
 * Compare pages reuse the parent benchmarks' Prom data, so freshness
 * inherits 1:1 from the underlying benches. ISR window matches the
 * /products/[slug] page because the same provider appearances back both.
 *
 * 60 s is enough in production because Vercel edge cache serves STALE
 * HTML while ISR regenerates in the background, so a visitor never
 * waits for SSR even when the window expires. Earlier attempts at
 * 300 s and 600 s were calibrated for the staging Preview env where
 * Vercel sets `cache-control: no-store` and disables ISR entirely; on
 * production that constraint disappears so the larger window only
 * traded freshness for nothing.
 */
export const revalidate = 60;
// Per-dimension variant fetches fan out N chain + N region loadBenchmark
// calls per shared bench. Cached, but cold ISR regeneration needs head
// room above the 60 s default to avoid mid-flight timeouts on a pair
// with multiple dimension-shape benches.
export const maxDuration = 300;

type Params = { slug: string };

export async function generateStaticParams() {
  return getComparePairSlugs().map((slug) => ({ slug }));
}

async function loadPairProviders(pair: ComparePair) {
  const [a, b] = await Promise.all([
    getProvider(pair.providerA),
    getProvider(pair.providerB),
  ]);
  return { a, b };
}

/** Split a `<a>-vs-<b>` slug. Provider slugs can themselves contain
 *  hyphens (`helius-sender`, `phantom-perps`, etc.), so we split on the
 *  exact `-vs-` delimiter, not on `-`. Returns null when the delimiter
 *  is missing or either side is empty. */
function parseAdHocSlug(slug: string): { a: string; b: string } | null {
  const idx = slug.indexOf("-vs-");
  if (idx <= 0) return null;
  const a = slug.slice(0, idx);
  const b = slug.slice(idx + "-vs-".length);
  if (!a || !b || a === b) return null;
  return { a, b };
}

/** Try to materialise a non-curated pair from any `<a>-vs-<b>` slug.
 *  Steps:
 *    1. Parse the slug into `a` and `b`.
 *    2. Reject if the canonical order (alphabetical) doesn't match the
 *       slug. Non-canonical URLs are redirected to the canonical form
 *       at the route layer so the slug stays the single source of truth.
 *    3. Verify both providers exist via getProvider.
 *    4. Verify they share at least one bench in their appearances, so
 *       the page renders something meaningful and not a "0 shared"
 *       empty state.
 *  Returns a synthetic ComparePair so the rest of the route works
 *  unchanged. Returns null when any of those checks fail.
 */
// HL builder addresses (0x...) leak into the provider catalog because
// the HL bench tracks builders by raw on-chain address. They have no
// search demand as compare targets, only pollute crawl budget.
// Drop them at the entry so /compare/0x...-vs-* 404s cleanly.
const HEX_SLUG_RE = /^0x[0-9a-f]{4,}$/i;

async function resolveAdHocPair(slug: string): Promise<ComparePair | null> {
  const parsed = parseAdHocSlug(slug);
  if (!parsed) return null;
  if (HEX_SLUG_RE.test(parsed.a) || HEX_SLUG_RE.test(parsed.b)) return null;
  const [first, second] = [parsed.a, parsed.b].sort();
  if (slug !== `${first}-vs-${second}`) return null;
  const [a, b] = await Promise.all([
    getProvider(first),
    getProvider(second),
  ]);
  if (!a || !b) return null;
  // No share check here: it was rejecting some valid pairs (provider
  // slug normalisation mismatched between getProvider and
  // p.appearances[].benchmark.slug in a few edge cases). If they truly
  // don't share, buildSharedBenches downstream returns [] and the page
  // 404s naturally with shared.length === 0. Same outcome, fewer false
  // negatives at the entry.
  return {
    slug,
    providerA: first,
    providerB: second,
    publishedAt: "2026-06-17",
  };
}

/** If the URL slug is `<a>-vs-<b>` but not alphabetical, send the
 *  visitor to the canonical form. Keeps a single canonical URL per
 *  pair from Google's perspective and matches the selector's
 *  `canonicalPairSlug` output. Returns the canonical slug when a
 *  redirect is needed, null when the slug is already canonical or not
 *  a valid pair shape. */
function canonicalisationTarget(slug: string): string | null {
  const parsed = parseAdHocSlug(slug);
  if (!parsed) return null;
  const [first, second] = [parsed.a, parsed.b].sort();
  const canonical = `${first}-vs-${second}`;
  return canonical === slug ? null : canonical;
}

/** Lightweight precheck: does this pair have at least one shared bench
 *  after applying the whitelist + exclude rules? Pure set arithmetic on
 *  the already-loaded provider appearances. No Prom calls, no KV
 *  lookup, no fan out.
 *
 *  Mirrors the candidate-slug computation inside `buildSharedBenches`
 *  so the two stay in lockstep. Called by `generateMetadata` so a pair
 *  whose providers both exist but share zero benches notFound()s
 *  before any HTML streams. */
function hasSharedBenches(
  pair: ComparePair,
  aAppearances: Awaited<ReturnType<typeof getProvider>>,
  bAppearances: Awaited<ReturnType<typeof getProvider>>,
): boolean {
  if (!aAppearances || !bAppearances) return false;
  const aSlugs = new Set(aAppearances.appearances.map((x) => x.benchmark.slug));
  const bSlugs = new Set(bAppearances.appearances.map((x) => x.benchmark.slug));
  const candidateSlugs = pair.benchmarks
    ? pair.benchmarks.filter((s) => aSlugs.has(s) && bSlugs.has(s))
    : Array.from(aSlugs).filter((s) => bSlugs.has(s));
  const excluded = new Set(pair.excludeBenchmarks ?? []);
  return candidateSlugs.some((s) => !excluded.has(s));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  // Run the same gating logic as the page render so non-canonical and
  // invalid slugs short-circuit at the metadata phase. Combined with
  // the loading.tsx removal in this hotfix, notFound() here cleanly
  // produces a real 308 / 404 response from the route layer instead
  // of a 200 wrapping a streamed loading skeleton.
  const canonicalTarget = canonicalisationTarget(slug);
  if (canonicalTarget) redirect(`/compare/${canonicalTarget}`);
  const pair = getComparePair(slug) ?? (await resolveAdHocPair(slug));
  if (!pair) notFound();
  const { a, b } = await loadPairProviders(pair);
  if (!a || !b) notFound();
  // Final SSR gate: an ad-hoc pair can have both providers resolved
  // yet share zero benches (e.g. an RPC provider vs an oracle).
  // Without this the page body's `shared.length === 0` check fires
  // late and the response loses its chance to demote the status code.
  // Cheap: only the appearance intersection, no Prom fan out.
  if (!hasSharedBenches(pair, a, b)) notFound();

  const url = `${SITE.url}/compare/${pair.slug}`;

  // SEO title carries the head-term shape ("X vs Y benchmark") plus
  // current year (LLM extractability). Format leads with both provider
  // names so Google's ~60-char SERP truncation keeps the intent-matching
  // portion. The suffix "· OpenChainBench" is added by Next's title
  // template so we don't spend chars on it here.
  const currentYear = new Date().getUTCFullYear();
  const title = `${a.name} vs ${b.name} Benchmark ${currentYear}`;

  // Compute shared bench count from appearances (already loaded via
  // hasSharedBenches above — cheap recomputation, avoids another Prom hit).
  const aSlugs = new Set(a.appearances.map((x) => x.benchmark.slug));
  const bSlugs = new Set(b.appearances.map((x) => x.benchmark.slug));
  const excluded = new Set(pair.excludeBenchmarks ?? []);
  const sharedSlugsForMeta = pair.benchmarks
    ? pair.benchmarks.filter((s) => aSlugs.has(s) && bSlugs.has(s))
    : Array.from(aSlugs).filter((s) => bSlugs.has(s));
  const sharedCount = sharedSlugsForMeta.filter((s) => !excluded.has(s)).length;
  const benchWord = sharedCount === 1 ? "benchmark" : "benchmarks";

  // Thin-content gate (SEO audit 2026-07-08): a pair whose shared
  // benches carry live data for both providers on fewer than 2 of them
  // renders either "awaiting live measurements" or a single card.
  // Those pages stay reachable (internal links + stale index entries
  // must not 404) but are marked noindex so direct hits stop counting
  // against the domain. Mirrors the >= 2 live-shared emission floor in
  // src/lib/compare/adhoc-pairs.ts so the sitemap never advertises a
  // noindexed URL. Live rule matches liveResults(): not "unavailable"
  // and p50 > 0, read off the already-loaded appearances.
  const aLive = new Set(
    a.appearances
      .filter(
        (x) => x.result.availability !== "unavailable" && x.result.ms.p50 > 0,
      )
      .map((x) => x.benchmark.slug),
  );
  const bLive = new Set(
    b.appearances
      .filter(
        (x) => x.result.availability !== "unavailable" && x.result.ms.p50 > 0,
      )
      .map((x) => x.benchmark.slug),
  );
  const liveSharedCount = sharedSlugsForMeta.filter(
    (s) => !excluded.has(s) && aLive.has(s) && bLive.has(s),
  ).length;
  // Curated pairs are hand-picked head-term targets like usdc-vs-usdt
  // and carry editorial framing beyond the ledger, so they stay
  // indexable even with a single live shared bench. Membership in
  // COMPARE_PAIRS is the curation signal; `pair.benchmarks` is only an
  // optional editorial override most curated entries do not set (the
  // previous check on it noindexed usdc-vs-usdt and
  // dydx-vs-hyperliquid in prod). The gate only applies to
  // combinatorial ad hoc pairs.
  const isCurated = getComparePair(pair.slug) !== undefined;
  const thin = !isCurated && liveSharedCount < 2;

  // Meta description: unique per pair via the shared-count + provider
  // names + date. Kills the identical duplicate-content signal that had
  // Bing indexing 2 of 4938 compare pages. Also cites "as of DATE" for
  // LLM citations.
  const isoDate = new Date().toISOString().split("T")[0];
  const description = capDescription(
    `${a.name} vs ${b.name} on ${sharedCount} shared OpenChainBench ${benchWord}. Live measurements, reproducible methodology. As of ${isoDate}.`,
    158,
  );

  return {
    title,
    description,
    // follow stays on so PageRank keeps flowing through the body links
    // (both provider pages, parent benches) even while deindexed.
    ...(thin ? { robots: { index: false, follow: true } } : {}),
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      type: "website",
      siteName: SITE.name,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      site: SITE.twitter,
    },
  };
}

type Panel = {
  rank: number;
  p50: number;
  p99: number;
  sampleSize?: number;
};

type BreakdownRow = {
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
type ChainRegionEntry = BreakdownRow & {
  regionRows: BreakdownRow[];
};

type SharedBench = {
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

/** Sort comparator that respects `higherIsBetter`. Returns:
 *    "a" if A leads, "b" if B leads, "tie" if both equal. */
function decideWinner(
  aP50: number,
  bP50: number,
  higherIsBetter: boolean,
): "a" | "b" | "tie" {
  if (aP50 === bP50) return "tie";
  if (higherIsBetter) return aP50 > bP50 ? "a" : "b";
  return aP50 < bP50 ? "a" : "b";
}

/** Build a data-driven prose summary of the head-to-head. Emitted above
 *  the fold so Google/Bing get substantive, unique text per pair instead
 *  of the identical template paragraph that used to sit here (which was
 *  a big contributor to Bing indexing only 2 of ~5000 URLs — SEO audit
 *  2026-07-05). Every sentence is derived from live measurements, no
 *  editorial claim. Falls back to a minimal statement when p50 data is
 *  missing (cold ISR, harness restart) so we never emit a lie. */
function buildComparisonProse(
  shared: SharedBench[],
  aName: string,
  bName: string,
): string {
  if (shared.length === 0) return "";
  const aWinTitles: string[] = [];
  const bWinTitles: string[] = [];
  const aWinLines: string[] = [];
  const bWinLines: string[] = [];
  let ties = 0;

  for (const s of shared) {
    const aP50 = s.aResult.p50;
    const bP50 = s.bResult.p50;
    if (aP50 <= 0 || bP50 <= 0) continue;
    const aVal = fmtUnit(aP50, s.unit);
    const bVal = fmtUnit(bP50, s.unit);
    if (s.aggregateWinner === "a") {
      aWinTitles.push(s.title);
      aWinLines.push(`${s.title} (${aVal} vs ${bVal})`);
    } else if (s.aggregateWinner === "b") {
      bWinTitles.push(s.title);
      bWinLines.push(`${s.title} (${bVal} vs ${aVal})`);
    } else {
      ties += 1;
    }
  }

  const total = aWinTitles.length + bWinTitles.length + ties;
  if (total === 0) {
    // No live data yet — return a neutral sentence rather than the old
    // templated intro so the meta description + title remain the only
    // duplicate-adjacent text on cold-cache pages.
    return `${aName} vs ${bName} on ${shared.length} shared OpenChainBench ${shared.length === 1 ? "benchmark" : "benchmarks"}, awaiting live measurements.`;
  }

  const parts: string[] = [];
  parts.push(
    `${aName} leads on ${aWinTitles.length} of ${total} shared benchmarks, ${bName} on ${bWinTitles.length}${ties > 0 ? ` (${ties} tied)` : ""}.`,
  );
  if (aWinLines.length > 0) {
    parts.push(`${aName} wins on ${aWinLines.slice(0, 4).join(", ")}.`);
  }
  if (bWinLines.length > 0) {
    parts.push(`${bName} wins on ${bWinLines.slice(0, 4).join(", ")}.`);
  }
  return parts.join(" ");
}

/** Load the per-dimension breakdown for one shared bench against one
 *  axis. Resolves each dimension value to a filtered Benchmark via
 *  loadBenchmark, then picks both providers' results. Drops rows where
 *  either provider lacks live data so we never render "0 vs 0" panels. */
async function loadBreakdown(
  benchSlug: string,
  axis: "chain" | "region",
  options: { value: string; label: string }[],
  providerA: string,
  providerB: string,
  higherIsBetter: boolean,
): Promise<BreakdownRow[]> {
  const filtered = options.filter(
    (o) => o.value.toLowerCase() !== "all",
  );
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
async function loadChainRegionMatrix(
  benchSlug: string,
  chainOpts: { value: string; label: string }[],
  regionOpts: { value: string; label: string }[],
  providerA: string,
  providerB: string,
  higherIsBetter: boolean,
): Promise<ChainRegionEntry[]> {
  const chains = chainOpts.filter((c) => c.value.toLowerCase() !== "all");
  const regions = regionOpts.filter((r) => r.value.toLowerCase() !== "all");
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
async function buildSharedBenches(
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
        chainOpts.filter((c) => c.value.toLowerCase() !== "all").length > 0 &&
        regionOpts.filter((r) => r.value.toLowerCase() !== "all").length > 0;

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

function fmtTs(iso?: string): string | null {
  if (!iso) return null;
  return new Date(iso).toUTCString().replace("GMT", "UTC");
}

export default async function ComparePage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  // Non-canonical slug (e.g. `bnb-vs-aptos`) gets 308 to the
  // alphabetical canonical (`aptos-vs-bnb`) before we do any rendering
  // so the selector and any backwards typed URL converge on the same
  // canonical for indexing.
  const canonicalTarget = canonicalisationTarget(slug);
  if (canonicalTarget) redirect(`/compare/${canonicalTarget}`);
  // Curated pairs in COMPARE_PAIRS win. Anything else falls through to
  // resolveAdHocPair which validates the providers exist and share at
  // least one bench before rendering. notFound otherwise.
  const pair = getComparePair(slug) ?? (await resolveAdHocPair(slug));
  if (!pair) return notFound();

  const { a, b } = await loadPairProviders(pair);
  if (!a || !b) return notFound();

  const shared = await buildSharedBenches(pair, a, b);
  if (shared.length === 0) return notFound();

  const regA = getProviderRegistry(a.slug);
  const regB = getProviderRegistry(b.slug);

  const url = `${SITE.url}/compare/${pair.slug}`;
  const latestTs = shared.reduce<string | null>((acc, s) => {
    if (!s.lastRunAt) return acc;
    if (!acc || new Date(s.lastRunAt) > new Date(acc)) return s.lastRunAt;
    return acc;
  }, null);

  const datasetJsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${url}#dataset`,
    identifier: url,
    name: `${a.name} vs ${b.name} OpenChainBench measurements`,
    description: `Side by side live measurements for ${a.name} and ${b.name} on ${shared.length} shared OpenChainBench benchmarks.`,
    url,
    creator: CREATOR_PUBLISHER,
    publisher: CREATOR_PUBLISHER,
    isAccessibleForFree: true,
    license: DATASET_LICENSE,
    measurementTechnique: `${SITE.url}/methodology`,
    variableMeasured: shared.map((s) => ({
      "@type": "PropertyValue",
      name: s.title,
      unitText: s.unit,
    })),
    isBasedOn: shared.map((s) => `${SITE.url}/benchmarks/${s.slug}`),
    distribution: shared.map((s) => ({
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${SITE.url}/api/stat/${s.slug}`,
    })),
    ...(latestTs ? { dateModified: latestTs } : {}),
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Compare", item: `${SITE.url}/compare` },
      { name: `${a.name} vs ${b.name}`, item: url },
    ]),
  };

  // FAQPage schema. Google + Bing both render rich FAQ dropdowns in the
  // SERP snippet for pages emitting valid FAQPage. Every answer here is
  // derived from live measurements — no editorial claim. Skipped when
  // shared is empty (never actually reached because notFound() short-
  // circuits above, but defensive).
  const faqEntries: Array<{ q: string; a: string }> = [];
  const aWinsBench = shared.find((s) => s.aggregateWinner === "a" && s.aResult.p50 !== 0 && s.bResult.p50 !== 0);
  const bWinsBench = shared.find((s) => s.aggregateWinner === "b" && s.aResult.p50 > 0 && s.bResult.p50 > 0);
  faqEntries.push({
    q: `${a.name} vs ${b.name}: which one is better?`,
    a: `${a.name} and ${b.name} are compared on ${shared.length} shared OpenChainBench benchmarks. ${aWinsBench ? `${a.name} leads on ${aWinsBench.title}.` : ""} ${bWinsBench ? `${b.name} leads on ${bWinsBench.title}.` : ""} See the live table on this page for every metric.`.trim(),
  });
  if (aWinsBench) {
    faqEntries.push({
      q: `Which is faster on ${aWinsBench.title.toLowerCase()}, ${a.name} or ${b.name}?`,
      a: `On the ${aWinsBench.title} benchmark, ${a.name} leads at ${fmtUnit(aWinsBench.aResult.p50, aWinsBench.unit)} versus ${b.name} at ${fmtUnit(aWinsBench.bResult.p50, aWinsBench.unit)}. Live measurement is updated continuously by the OpenChainBench harness.`,
    });
  }
  if (bWinsBench) {
    faqEntries.push({
      q: `Which is faster on ${bWinsBench.title.toLowerCase()}, ${a.name} or ${b.name}?`,
      a: `On the ${bWinsBench.title} benchmark, ${b.name} leads at ${fmtUnit(bWinsBench.bResult.p50, bWinsBench.unit)} versus ${a.name} at ${fmtUnit(bWinsBench.aResult.p50, bWinsBench.unit)}. Live measurement is updated continuously by the OpenChainBench harness.`,
    });
  }
  faqEntries.push({
    q: `How is the ${a.name} vs ${b.name} comparison measured?`,
    a: `Every benchmark on this page uses the same open methodology, published at ${SITE.url}/methodology. Data is CC-BY-4.0. Measurement harnesses are MIT-licensed.`,
  });

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqEntries.map((e) => ({
      "@type": "Question",
      name: e.q,
      acceptedAnswer: { "@type": "Answer", text: e.a },
    })),
  };

  const comparisonProse = buildComparisonProse(shared, a.name, b.name);

  return (
    <main className="mx-auto max-w-5xl px-6 pt-10 pb-16 sm:pt-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(datasetJsonLd) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbJsonLd) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(faqJsonLd) }}
      />

      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          { label: "Compare", href: "/compare" },
          { label: `${a.name} vs ${b.name}` },
        ]}
      />

      <nav className="mb-6 flex items-center gap-3 text-sm text-ink-soft">
        <Link
          href="/compare"
          className="inline-flex items-center gap-1 hover:text-ink"
        >
          <ArrowLeft size={14} /> All comparisons
        </Link>
      </nav>

      <header className="border-b-2 border-ink pb-6">
        <h1 className="display text-3xl tracking-tight sm:text-4xl text-ink">
          {a.name} <span className="text-ink-soft font-normal">vs</span>{" "}
          {b.name}
        </h1>
        <p className="mt-3 max-w-2xl text-base text-ink-soft leading-snug">
          {comparisonProse ||
            `${a.name} vs ${b.name} on ${shared.length} shared OpenChainBench ${shared.length === 1 ? "benchmark" : "benchmarks"}. Live measurements, reproducible methodology, per-chain and per-region breakdowns straight from the Prometheus queries driving the parent benchmark pages.`}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-ink-muted">
          <Link
            href="/methodology"
            className="inline-flex items-center gap-1 hover:text-ink"
          >
            Read methodology <ArrowUpRight size={11} />
          </Link>
          {latestTs && (
            <span>
              Last measured{" "}
              <time
                dateTime={new Date(latestTs).toISOString()}
                className="text-ink-soft"
              >
                {fmtTs(latestTs)}
              </time>
            </span>
          )}
          <span>Window: rolling 24h</span>
          <span>
            {shared.length} shared{" "}
            {shared.length === 1 ? "benchmark" : "benchmarks"}
          </span>
        </div>
      </header>

      <section className="mt-8 grid grid-cols-2 gap-4 sm:gap-6">
        <ProviderHeader
          slug={a.slug}
          name={a.name}
          description={regA?.description}
        />
        <ProviderHeader
          slug={b.slug}
          name={b.name}
          description={regB?.description}
        />
      </section>

      <section className="mt-10">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          Side by side measurements
        </h2>
        <div className="mt-4 space-y-5">
          {shared.map((s) => (
            <BenchCard
              key={s.slug}
              bench={s}
              aName={a.name}
              bName={b.name}
            />
          ))}
        </div>
      </section>

      <section className="mt-12 max-w-3xl">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          How this pair was selected
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          A pair is published when all four conditions hold. Both
          providers run in the same OpenChainBench benchmark for at
          least seven consecutive days. Each provider has at least 1000
          samples in the measurement window. The head to head query has
          observable third party search demand. Both providers have a
          public <code>/products/[slug]</code> page on OCB. The full
          pair ledger is versioned in the public repo so the
          methodology is externally verifiable.
        </p>
      </section>

      <footer className="mt-12 border-t border-rule pt-6 text-xs text-ink-muted">
        Live data refreshes via ISR within 60 seconds of a new run.
        Sources are the same Prometheus queries surfaced on the parent
        benchmark pages.
      </footer>
    </main>
  );
}

function ProviderHeader({
  slug,
  name,
  description,
}: {
  slug: string;
  name: string;
  description?: string;
}) {
  return (
    <div className="flex items-center gap-3 border border-rule p-4 rounded-xl">
      <ProviderLogo slug={slug} name={name} size={40} />
      <div className="min-w-0">
        <Link
          href={`/products/${slug}`}
          className="font-medium hover:underline text-ink"
        >
          {name}
        </Link>
        {description && (
          <p className="mt-0.5 text-[11px] text-ink-muted leading-snug line-clamp-2">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}

function BenchCard({
  bench,
  aName,
  bName,
}: {
  bench: SharedBench;
  aName: string;
  bName: string;
}) {
  return (
    <article className="border border-rule rounded-2xl p-5 sm:p-6">
      <header className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="display text-base sm:text-lg tracking-tight text-ink leading-tight">
          <Link
            href={`/benchmarks/${bench.slug}`}
            className="hover:underline"
          >
            {bench.title}
          </Link>
        </h3>
        <span className="text-[10px] uppercase tracking-[0.16em] text-ink-faint shrink-0">
          {bench.category}
        </span>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        <AggregatePanel
          name={aName}
          panel={bench.aResult}
          unit={bench.unit}
          winner={bench.aggregateWinner === "a"}
          loser={bench.aggregateWinner === "b"}
        />
        <AggregatePanel
          name={bName}
          panel={bench.bResult}
          unit={bench.unit}
          winner={bench.aggregateWinner === "b"}
          loser={bench.aggregateWinner === "a"}
        />
      </div>

      {bench.chainRegionMatrix.length > 0 ? (
        <ChainRegionMatrix
          entries={bench.chainRegionMatrix}
          aName={aName}
          bName={bName}
          unit={bench.unit}
        />
      ) : (
        <>
          {bench.chainBreakdown.length > 0 && (
            <BreakdownTable
              title="Per chain"
              rows={bench.chainBreakdown}
              aName={aName}
              bName={bName}
              unit={bench.unit}
            />
          )}
          {bench.regionBreakdown.length > 0 && (
            <BreakdownTable
              title="Per region"
              rows={bench.regionBreakdown}
              aName={aName}
              bName={bName}
              unit={bench.unit}
            />
          )}
        </>
      )}

      <footer className="mt-5 border-t border-rule pt-3 flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
        <span>Rolling 24h · {bench.metric}</span>
        <Link
          href={`/api/stat/${bench.slug}`}
          className="hover:text-ink-soft normal-case tracking-normal"
        >
          Raw JSON
        </Link>
      </footer>
    </article>
  );
}

function AggregatePanel({
  name,
  panel,
  unit,
  winner,
  loser,
}: {
  name: string;
  panel: Panel;
  unit: Benchmark["unit"];
  winner: boolean;
  loser: boolean;
}) {
  const hasData = panel.rank > 0 && panel.p50 > 0;
  const containerCls = winner
    ? "border-good/60 bg-good/5"
    : loser
      ? "border-bad/40 bg-bad/5"
      : "border-rule bg-surface";
  const headlineCls = winner
    ? "text-good"
    : loser
      ? "text-bad"
      : "text-ink";
  return (
    <div
      className={`rounded-xl px-4 py-4 border flex flex-col gap-2 ${containerCls}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] uppercase tracking-[0.16em] text-ink-muted font-medium">
          {name}
        </p>
        {winner && hasData && (
          <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-good">
            Leads
          </span>
        )}
        {loser && hasData && (
          <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-bad">
            Trails
          </span>
        )}
      </div>
      {hasData ? (
        <>
          <p
            className={`display text-3xl sm:text-4xl tracking-tight tabular leading-none ${headlineCls}`}
          >
            {fmtValue(panel.p50, unit)}
            <span className="ml-1 text-base text-ink-muted">
              {unitSuffix(unit, panel.p50)}
            </span>
          </p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-ink-muted tabular">
            <dt>p99</dt>
            <dd className="text-right text-ink-soft">
              {fmtUnit(panel.p99, unit)}
            </dd>
            <dt>rank</dt>
            <dd className="text-right text-ink-soft">#{panel.rank}</dd>
            {panel.sampleSize ? (
              <>
                <dt>samples</dt>
                <dd className="text-right text-ink-soft">
                  {Math.round(panel.sampleSize).toLocaleString()}
                </dd>
              </>
            ) : null}
          </dl>
        </>
      ) : (
        <p className="text-sm text-ink-faint">No data in window</p>
      )}
    </div>
  );
}

/** Single flat 2D matrix used when a bench exposes both `chain` and
 *  `region` dimensions. Rows are grouped per chain (rowspan on the chain
 *  cell), two sub-rows per chain (one per provider). Columns expand
 *  across every region observed for the pair plus an aggregate column on
 *  the right. Each value cell is colored by the per-cell winner so the
 *  table reads as a heatmap: green = leads here, red = trails. */
function ChainRegionMatrix({
  entries,
  aName,
  bName,
  unit,
}: {
  entries: ChainRegionEntry[];
  aName: string;
  bName: string;
  unit: Benchmark["unit"];
}) {
  const regionMap = new Map<string, string>();
  for (const entry of entries) {
    for (const r of entry.regionRows) {
      if (!regionMap.has(r.value)) regionMap.set(r.value, r.label);
    }
  }
  const regions = Array.from(regionMap.entries()).map(([value, label]) => ({
    value,
    label,
  }));

  const valueCell = (win: boolean, lose: boolean, isAggregate = false) => {
    const color = win
      ? "text-good font-medium"
      : lose
        ? "text-bad"
        : "text-ink";
    return `py-2 px-2 text-right whitespace-nowrap ${isAggregate ? "border-l border-rule" : ""} ${color}`;
  };
  const emptyCell = (isAggregate = false) =>
    `py-2 px-2 text-right text-ink-faint ${isAggregate ? "border-l border-rule" : ""}`;

  return (
    <div className="mt-6 border-t border-rule pt-4">
      <p className="text-[11px] uppercase tracking-[0.18em] text-ink-muted font-medium mb-3">
        Per chain · per region
      </p>
      <div className="overflow-x-auto -mx-5 sm:-mx-6 px-5 sm:px-6">
        <table className="w-full text-sm tabular border-collapse">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.16em] text-ink-faint border-b border-rule">
              <th
                scope="col"
                className="text-left font-medium py-2 pr-3 sticky left-0 bg-bg z-10"
              >
                Chain
              </th>
              <th scope="col" className="text-left font-medium py-2 px-3">
                Provider
              </th>
              {regions.map((r) => (
                <th
                  key={r.value}
                  scope="col"
                  className="text-right font-medium py-2 px-2"
                >
                  {r.label}
                </th>
              ))}
              <th
                scope="col"
                className="text-right font-medium py-2 pl-3 pr-1 border-l border-rule"
              >
                Aggregate
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const byRegion = new Map(
                entry.regionRows.map((r) => [r.value, r] as const),
              );
              return (
                <Fragment key={entry.value}>
                  <tr className="border-t border-rule">
                    <th
                      scope="rowgroup"
                      rowSpan={2}
                      className="py-2 pr-3 text-left text-ink-soft font-medium align-top sticky left-0 bg-bg border-r border-rule/60"
                    >
                      {entry.label}
                    </th>
                    <td className="py-2 px-3 text-[11px] uppercase tracking-[0.14em] text-ink-muted">
                      {aName}
                    </td>
                    {regions.map((r) => {
                      const row = byRegion.get(r.value);
                      return row ? (
                        <td
                          key={r.value}
                          className={valueCell(row.aWins, row.bWins)}
                        >
                          {fmtUnit(row.aP50, unit)}
                        </td>
                      ) : (
                        <td key={r.value} className={emptyCell()}>
                          -
                        </td>
                      );
                    })}
                    <td className={valueCell(entry.aWins, entry.bWins, true)}>
                      {fmtUnit(entry.aP50, unit)}
                    </td>
                  </tr>
                  <tr className="border-b border-rule">
                    <td className="py-2 px-3 text-[11px] uppercase tracking-[0.14em] text-ink-muted">
                      {bName}
                    </td>
                    {regions.map((r) => {
                      const row = byRegion.get(r.value);
                      return row ? (
                        <td
                          key={r.value}
                          className={valueCell(row.bWins, row.aWins)}
                        >
                          {fmtUnit(row.bP50, unit)}
                        </td>
                      ) : (
                        <td key={r.value} className={emptyCell()}>
                          -
                        </td>
                      );
                    })}
                    <td className={valueCell(entry.bWins, entry.aWins, true)}>
                      {fmtUnit(entry.bP50, unit)}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
  aName,
  bName,
  unit,
}: {
  title: string;
  rows: BreakdownRow[];
  aName: string;
  bName: string;
  unit: Benchmark["unit"];
}) {
  return (
    <div className="mt-6 border-t border-rule pt-4">
      <p className="text-[11px] uppercase tracking-[0.18em] text-ink-muted font-medium mb-3">
        {title}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.16em] text-ink-faint border-b border-rule">
              <th className="text-left font-medium pb-2 pr-3">
                {title === "Per region" ? "Region" : "Chain"}
              </th>
              <th className="text-right font-medium pb-2 px-3">{aName}</th>
              <th className="text-right font-medium pb-2 pl-3">{bName}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rows.map((row) => (
              <tr key={row.value}>
                <td className="py-2 pr-3 text-ink-soft">{row.label}</td>
                <td
                  className={`py-2 px-3 text-right ${row.aWins ? "text-good font-medium" : row.bWins ? "text-bad" : "text-ink"}`}
                >
                  {fmtUnit(row.aP50, unit)}
                </td>
                <td
                  className={`py-2 pl-3 text-right ${row.bWins ? "text-good font-medium" : row.aWins ? "text-bad" : "text-ink"}`}
                >
                  {fmtUnit(row.bP50, unit)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
