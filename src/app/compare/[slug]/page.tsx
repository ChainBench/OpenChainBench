import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { getProvider, canonicalize } from "@/lib/providers";
import { loadBenchmark } from "@/lib/spec";
import {
  COMPARE_PAIRS,
  getComparePair,
  getComparePairSlugs,
  type ComparePair,
} from "@/data/compare-pairs";
import { getProviderRegistry } from "@/data/provider-registry";
import { ProviderLogo } from "@/components/provider-logo";
import { fmtUnit } from "@/lib/format";
import { capDescription, capSnippet } from "@/lib/seo-text";
import { Breadcrumb } from "@/components/breadcrumb";
import { buildBreadcrumbJsonLd, safeJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { buildCitationMeta } from "@/lib/dataset-jsonld";
import { CREATOR_PUBLISHER, DATASET_LICENSE } from "@/lib/dataset-jsonld";
import { CompareBenchCard } from "@/components/compare-bench-card";
import { PerpVolumeHeadToHead } from "@/components/perp-volume-head-to-head-section";
import { PERP_VOLUME_COHORT } from "@/lib/perp-volume-history";
import type { CompareBench } from "@/components/compare-bench-card";
import {
  computeInputsHash,
  readPairCache,
  writePairCache,
} from "@/lib/compare-cache";
import { sharedBenchSlugs } from "@/lib/compare-compute";

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
export const revalidate = 3600;
// Per-dimension variant fetches fan out N chain + N region loadBenchmark
// calls per shared bench. Cached, but cold ISR regeneration needs head
// room above the 60 s default to avoid mid-flight timeouts on a pair
// with multiple dimension-shape benches.
export const maxDuration = 120;

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
  return sharedBenchSlugs(pair, aAppearances.appearances, bAppearances.appearances).length > 0;
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

  // Compute shared bench count from appearances (already loaded via
  // hasSharedBenches above — cheap recomputation, avoids another Prom hit).
  const sharedSlugsForMeta = sharedBenchSlugs(pair, a.appearances, b.appearances);
  // Title and description count the benches with live data for both
  // sides (the lede's number), not every shared slug: the two read as one
  // fact on the page (11 vs 9 on gains-vs-gmx, audit 2026-09-21).
  const sharedCount = sharedSlugsForMeta.length;
  const liveForMeta = sharedSlugsForMeta.filter((s) => {
    const okA = a.appearances.some((x) => x.benchmark.slug === s && x.result.availability !== "unavailable" && x.result.ms.p50 > 0);
    const okB = b.appearances.some((x) => x.benchmark.slug === s && x.result.availability !== "unavailable" && x.result.ms.p50 > 0);
    return okA && okB;
  }).length;
  const metaCount = liveForMeta > 0 ? liveForMeta : sharedCount;
  const benchWord = metaCount === 1 ? "benchmark" : "benchmarks";

  // Title carries the count: `LI.FI vs Relay 2026: 2 live benchmarks compared`
  // (audit 2026-09-19, major 4: the previous form named no number).
  const title = `${a.name} vs ${b.name} ${currentYear}: ${metaCount} live ${benchWord} compared`;

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
    (s) => aLive.has(s) && bLive.has(s),
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
  // LLM citations. The date is the newest measurement across the shared
  // benches, not the render clock: a description that restamped itself
  // on every ISR pass advertised freshness the data did not have.
  const newestRun = [...a.appearances, ...b.appearances]
    .filter((x) => sharedSlugsForMeta.includes(x.benchmark.slug))
    .map((x) => Date.parse(x.benchmark.lastRunAt ?? ""))
    .filter((t) => Number.isFinite(t))
    .sort((x, y) => y - x)[0];
  const isoDate = new Date(newestRun ?? Date.now()).toISOString().split("T")[0];
  // The verdict the body lede opens with ("Hyperliquid leads on 5 of 13
  // shared benchmarks, Lighter on 8"), not a count and a date alone: the
  // compare template converts best on the site and its snippet said
  // nothing measurable (audit 2026-09-22).
  const verdictRows = await buildSharedBenches(pair, a, b);
  let aWins = 0;
  let bWins = 0;
  let scored = 0;
  for (const s of verdictRows) {
    if (s.aResult.p50 <= 0 || s.bResult.p50 <= 0) continue;
    scored += 1;
    if (s.aggregateWinner === "a") aWins += 1;
    else if (s.aggregateWinner === "b") bWins += 1;
  }
  // The counts alone (a split-decision lede lists four bench labels with
  // values and runs past the budget); the tail carries the date.
  const verdict =
    scored === 0
      ? ""
      : aWins === bWins
        ? `${a.name} and ${b.name} split ${scored} shared ${scored === 1 ? "benchmark" : "benchmarks"} evenly.`
        : `${aWins >= bWins ? a.name : b.name} leads on ${Math.max(aWins, bWins)} of ${scored} shared ${scored === 1 ? "benchmark" : "benchmarks"}, ${aWins >= bWins ? b.name : a.name} on ${Math.min(aWins, bWins)}.`;
  const description = capSnippet(
    verdict
      ? `${verdict} Fees, volume, funding and latency measured live. As of ${isoDate}.`
      : `${a.name} vs ${b.name} on ${metaCount} shared OpenChainBench ${benchWord} with live data. Reproducible methodology. As of ${isoDate}.`,
  );

  return {
    // Past 43 characters the brand suffix cuts the count off the title.
    title: title.length > 43 ? { absolute: title } : title,
    description,
    // follow stays on so PageRank keeps flowing through the body links
    // (both provider pages, parent benches) even while deindexed.
    ...(thin ? { robots: { index: false, follow: true } } : {}),
    alternates: { canonical: url },
    other: buildCitationMeta({ title, url, asOfIso: isoDate, jsonUrl: `${SITE.url}/api/citable` }),
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

type SharedBench = CompareBench;

/** Short display titles for compare verdict/FAQ prose.
 *  Overrides shortBenchTitle() for benches whose YAML title is written
 *  for the bench page (long, SEO-optimised) rather than inline prose. */
const COMPARE_BENCH_TITLES: Record<string, string> = {
  "memecoin-platforms": "Memecoin trading fees",
  "app-store-ratings": "iOS App Store rating",
};

/** Maps a bench to the right comparative verb for FAQ questions. */
function verbForBench(bench: SharedBench): string {
  const unit = (bench.unit ?? "").toLowerCase();
  // Direction first: a higher-is-better USD bench (24h perp volume) is
  // not "cheaper", a lower-is-better ratio (P/E) is not "faster"
  // (audit 2026-09-21: "Which is cheaper on 24h perp volume").
  if (bench.higherIsBetter && (unit === "usd" || unit === "count" || unit === "bps" || unit === "bp")) return "higher on";
  if (!bench.higherIsBetter && unit === "x") return "lower on";
  if (unit === "usd" || unit === "gwei" || unit === "bps" || unit === "bp") return "cheaper";
  if ((unit === "pct" || unit === "sol") && !bench.higherIsBetter) return "cheaper";
  if (unit === "x" && bench.higherIsBetter) return "higher-rated";
  if (unit === "count" && bench.higherIsBetter) return "more active";
  if (bench.higherIsBetter) return "more reliable";
  return "faster";
}

/** "Which is faster, A or B?" / "Which has the higher 24h volume, A or B?" */
function whichQuestion(verb: string, metric: string | null, a: string, b: string): string {
  if (verb === "higher on" || verb === "lower on") {
    const adj = verb === "higher on" ? "higher" : "lower";
    return `Which has the ${adj} ${(metric ?? "value").toLowerCase()}, ${a} or ${b}?`;
  }
  return metric ? `Which is ${verb} on ${metric.toLowerCase()}, ${a} or ${b}?` : `Which is ${verb}, ${a} or ${b}?`;
}

/** Strips provider-list suffixes from bench titles for use in FAQ and
 *  verdict prose. Handles two patterns:
 *   "(A vs B vs C)" parenthetical → "Cheapest platform to trade memecoins"
 *   ": A vs B, live" colon suffix  → "Crypto trading app iOS ratings" */
function shortBenchTitle(title: string): string {
  const parenIdx = title.indexOf(" (");
  if (parenIdx > 0) return title.slice(0, parenIdx);
  const colonIdx = title.indexOf(": ");
  if (colonIdx > 0) return title.slice(0, colonIdx);
  return title;
}

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
    const dt = s.compareTitle ?? shortBenchTitle(s.title);
    if (s.aggregateWinner === "a") {
      aWinTitles.push(dt);
      aWinLines.push(`${dt} (${aVal} vs ${bVal})`);
    } else if (s.aggregateWinner === "b") {
      bWinTitles.push(dt);
      bWinLines.push(`${dt} (${bVal} vs ${aVal})`);
    } else {
      ties += 1;
    }
  }

  const total = aWinTitles.length + bWinTitles.length + ties;
  if (total === 0) {
    return `${aName} vs ${bName} on ${shared.length} shared OpenChainBench ${shared.length === 1 ? "benchmark" : "benchmarks"}, awaiting live measurements.`;
  }

  const parts: string[] = [];
  if (aWinTitles.length === 0) {
    const word = total === 1 ? "the only live benchmark" : total === 2 ? "both live benchmarks" : `all ${total} live benchmarks`;
    parts.push(`${bName} leads on ${word}.`);
  } else if (bWinTitles.length === 0) {
    const word = total === 1 ? "the only live benchmark" : total === 2 ? "both live benchmarks" : `all ${total} live benchmarks`;
    parts.push(`${aName} leads on ${word}.`);
  } else if (aWinTitles.length === bWinTitles.length) {
    // Fused: one line with values — this also becomes the meta description.
    const aPart = `${aName} leads on ${aWinLines.slice(0, 2).join(" and ")}`;
    const bPart = `${bName} leads on ${bWinLines.slice(0, 2).join(" and ")}`;
    return `Split decision: ${aPart}; ${bPart}.`;
  } else {
    parts.push(
      `${aName} leads on ${aWinTitles.length} of ${total} shared benchmarks, ${bName} on ${bWinTitles.length}${ties > 0 ? ` (${ties} tied)` : ""}.`,
    );
  }
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
  tier?: string,
): Promise<BreakdownRow[]> {
  const filtered = options.filter(
    (o) => o.value.toLowerCase() !== "all",
  );
  if (filtered.length === 0) return [];
  const rows = await Promise.all(
    filtered.map(async (opt) => {
      const variant = await loadBenchmark(benchSlug, {
        [axis]: opt.value,
        ...(tier ? { tier } : {}),
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
  tier?: string,
): Promise<ChainRegionEntry[]> {
  const chains = chainOpts.filter((c) => c.value.toLowerCase() !== "all");
  const regions = regionOpts.filter((r) => r.value.toLowerCase() !== "all");
  if (chains.length === 0 || regions.length === 0) return [];

  const scope = tier ? { tier } : {};
  const chainTasks = chains.map((c) =>
    loadBenchmark(benchSlug, { chain: c.value, ...scope }),
  );
  const regionTasks = chains.flatMap((c) =>
    regions.map((r) =>
      loadBenchmark(benchSlug, {
        chain: c.value,
        region: r.value,
        ...scope,
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
  // Same access cohort only: see sharedBenchSlugs.
  const sharedSlugs = sharedBenchSlugs(pair, aAppearances.appearances, bAppearances.appearances);

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
      const tier = aEntry.tier;
      const fullBench = await loadBenchmark(benchSlug, tier ? { tier } : {});
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
                tier,
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
                tier,
              ),
          hasBothDims
            ? loadChainRegionMatrix(
                benchSlug,
                chainOpts,
                regionOpts,
                aAppearances.slug,
                bAppearances.slug,
                higherIsBetter,
                tier,
              )
            : Promise.resolve<ChainRegionEntry[]>([]),
        ]);

      const extraScopes = (fullBench.metricPanels ?? [])
        .filter((p) => p.tab !== false)
        .flatMap((p) => {
          const aVal = p.values[aAppearances.slug];
          const bVal = p.values[bAppearances.slug];
          if (aVal == null || bVal == null) return [];
          return [
            {
              id: p.id,
              label: p.label,
              unit: p.unit,
              higherIsBetter: p.higherIsBetter,
              aValue: aVal,
              bValue: bVal,
              // "count" panels are size metrics — no win/lose coloring.
              neutral: (p.unit ?? "").toLowerCase() === "count",
            },
          ];
        });

      // When extra panels exist, prepend the main bench metric as the
      // first column so the primary comparison is never hidden by the
      // scope table replacing the aggregate panel.
      const panelScopes =
        extraScopes.length > 0 && aPanel.p50 > 0 && bPanel.p50 > 0
          ? [
              {
                id: "main",
                label: fullBench.metric,
                unit: fullBench.unit,
                higherIsBetter,
                aValue: aPanel.p50,
                bValue: bPanel.p50,
              },
              ...extraScopes,
            ]
          : extraScopes;

      return {
        slug: fullBench.slug,
        title: fullBench.title,
        compareTitle: COMPARE_BENCH_TITLES[fullBench.slug],
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
        panelScopes,
        note: fullBench.disclaimer ?? undefined,
      } as SharedBench;
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

  // Related curated pairs involving either provider — internal linking for
  // orphan-page mitigation (SEO audit 2026-08-12). Uses static COMPARE_PAIRS
  // so no extra Prom round trip. Capped at 6 to stay compact.
  const relatedPairs = COMPARE_PAIRS.filter(
    (p) =>
      p.slug !== pair.slug &&
      (p.providerA === pair.providerA ||
        p.providerB === pair.providerA ||
        p.providerA === pair.providerB ||
        p.providerB === pair.providerB),
  ).slice(0, 6);

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
    // PropertyValue in a Dataset variableMeasured needs a numeric `value`
    // for Google Dataset Search + academic LLM tools to extract the
    // structured fact. Fallback to the aggregate winner's p50 in the
    // shared unit; skip PropertyValue.value entirely when neither side
    // returned data so we never publish a fabricated zero.
    variableMeasured: shared.map((s) => {
      const winner = s.aggregateWinner === "a" ? s.aResult : s.bResult;
      const v = winner?.p50;
      return {
        "@type": "PropertyValue" as const,
        name: s.title,
        unitText: s.unit,
        ...(typeof v === "number" && v > 0 ? { value: v } : {}),
      };
    }),
    // isBasedOn is a cross-doc reference to each bench Dataset. Google
    // validates each Dataset in isolation and does not stitch bare-URL
    // refs, so previously flagged them as standalone Datasets without
    // name/description (same failure mode as PR #1442's isBasedOn fix
    // in dataset-jsonld.ts). Inline the required fields per bench.
    isBasedOn: shared.map((s) => ({
      "@type": "Dataset" as const,
      "@id": `${SITE.url}/benchmarks/${s.slug}#dataset`,
      name: s.title,
      description: `${s.metric} (${s.unit}) benchmark on OpenChainBench: live measurements for ${a.name} and ${b.name}.`,
      url: `${SITE.url}/benchmarks/${s.slug}`,
      creator: CREATOR_PUBLISHER,
      license: DATASET_LICENSE,
      isAccessibleForFree: true,
    })),
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
  // Appends "(provisional)" when sampleSize < 100 so FAQ answers
  // don't assert a fact the table already flags as uncertain.
  const fmtResult = (val: number, unit: CompareBench["unit"], n?: number) => {
    const s = fmtUnit(val, unit);
    return (n ?? 0) > 0 && (n ?? 0) < 100 ? `${s} (provisional)` : s;
  };

  const faqEntries: Array<{ q: string; a: string }> = [];
  const aWinsBench = shared.find((s) => s.aggregateWinner === "a" && s.aResult.p50 !== 0 && s.bResult.p50 !== 0);
  const bWinsBench = shared.find((s) => s.aggregateWinner === "b" && s.aResult.p50 > 0 && s.bResult.p50 > 0);
  faqEntries.push({
    q: `${a.name} vs ${b.name}: which one is better?`,
    a: `${a.name} and ${b.name} are compared on ${shared.length} shared OpenChainBench benchmarks. ${aWinsBench ? `${a.name} leads on ${aWinsBench.compareTitle ?? shortBenchTitle(aWinsBench.title)}.` : ""} ${bWinsBench ? `${b.name} leads on ${bWinsBench.compareTitle ?? shortBenchTitle(bWinsBench.title)}.` : ""} See the live table on this page for every metric.`.trim(),
  });
  // When both winners share the verb ("faster" for every ms bench) the
  // two questions collided and FAQPage carried a duplicate question
  // (audit 2026-09-19, major 4); name the bench in the question then.
  const sameVerb =
    aWinsBench && bWinsBench && verbForBench(aWinsBench) === verbForBench(bWinsBench);
  const whichQ = (bench: SharedBench) => {
    const verb = verbForBench(bench);
    const needsMetric = sameVerb || verb === "higher on" || verb === "lower on";
    return whichQuestion(verb, needsMetric ? bench.metric : null, a.name, b.name);
  };
  if (aWinsBench) {
    const st = shortBenchTitle(aWinsBench.title);
    faqEntries.push({
      q: whichQ(aWinsBench),
      a: `On the ${st} benchmark, ${a.name} leads at ${fmtResult(aWinsBench.aResult.p50, aWinsBench.unit, aWinsBench.aResult.sampleSize)} versus ${b.name} at ${fmtResult(aWinsBench.bResult.p50, aWinsBench.unit, aWinsBench.bResult.sampleSize)}. Live measurement is updated continuously by the OpenChainBench harness.`,
    });
  }
  if (bWinsBench) {
    const st = shortBenchTitle(bWinsBench.title);
    faqEntries.push({
      q: whichQ(bWinsBench),
      a: `On the ${st} benchmark, ${b.name} leads at ${fmtResult(bWinsBench.bResult.p50, bWinsBench.unit, bWinsBench.bResult.sampleSize)} versus ${a.name} at ${fmtResult(bWinsBench.aResult.p50, bWinsBench.unit, bWinsBench.aResult.sampleSize)}. Live measurement is updated continuously by the OpenChainBench harness.`,
    });
  }
  faqEntries.push({
    q: `How is the ${a.name} vs ${b.name} comparison measured?`,
    a: `Every benchmark on this page uses the same open methodology, published at ${SITE.url}/methodology. Data is CC-BY-4.0. Measurement harnesses are MIT-licensed.`,
  });
  // Belt and braces: FAQPage rejects duplicate questions.
  const seenQ = new Set<string>();
  const dedupedFaq = faqEntries.filter((f) => {
    const k = f.q.trim().toLowerCase();
    if (seenQ.has(k)) return false;
    seenQ.add(k);
    return true;
  });
  faqEntries.length = 0;
  faqEntries.push(...dedupedFaq);

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    // GSC's Rich Results tester flags FAQPage nodes without an `@id`
    // (every other FAQPage on the site emits one via the shared builder).
    "@id": `${url}#faq`,
    // Google's Rich Results validator flags missing `name` on the
    // FAQPage parent even when Question.name is set. Add here + on
    // Answer nodes so the compare page matches the shared FAQ builder
    // in src/lib/jsonld.ts.
    name: `${a.name} vs ${b.name}: frequently asked questions`,
    mainEntity: faqEntries.map((e) => ({
      "@type": "Question",
      name: e.q,
      acceptedAnswer: { "@type": "Answer", name: e.q, text: e.a },
    })),
  };

  // Dated like the meta description: the newest measurement across the
  // shared benches, so the page body carries the as-of the snippet states.
  const proseRun = [...a.appearances, ...b.appearances]
    .filter((x) => shared.some((s) => s.slug === x.benchmark.slug))
    .map((x) => Date.parse(x.benchmark.lastRunAt ?? ""))
    .filter((t) => Number.isFinite(t))
    .sort((x, y) => y - x)[0];
  const proseAsOf = proseRun ? ` Data as of ${new Date(proseRun).toISOString().split("T")[0]} UTC.` : "";
  const baseProse = buildComparisonProse(shared, a.name, b.name);
  const comparisonProse = baseProse ? baseProse + proseAsOf : "";
  // The title and the lede count the benches with a decided winner; the
  // header badge counted every shared bench, so a reader saw 13 and 14
  // on one screen (audit 2026-09-22).
  const decidedCount = shared.filter((s) => s.aResult.p50 > 0 && s.bResult.p50 > 0 && s.aggregateWinner !== "tie").length;
  const perpPair =
    pair.hero === "perp-volume" ||
    (PERP_VOLUME_COHORT.has(a.slug) && PERP_VOLUME_COHORT.has(b.slug));

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
            {decidedCount < shared.length ? `, ${decidedCount} with a measured winner` : ""}
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

      {perpPair && (
        <PerpVolumeHeadToHead
          aSlug={a.slug}
          bSlug={b.slug}
          aName={a.name}
          bName={b.name}
        />
      )}

      <section className="mt-10">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          Side by side measurements
        </h2>
        <div className="mt-4 space-y-5">
          {shared.map((s) => (
            <CompareBenchCard
              key={s.slug}
              bench={s}
              aName={a.name}
              bName={b.name}
              aSlug={a.slug}
              bSlug={b.slug}
            />
          ))}
        </div>
      </section>

      {/* Visible FAQ parity with the FAQPage JSON-LD above. Google
          requires visible Q&A text matching the schema entries or it
          silently drops the rich result — the compare pages had FAQ
          jsonld without any visible questions, so the FAQPage never
          rendered in the SERP snippet. */}
      <section className="mt-12 max-w-3xl">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          Frequently asked questions
        </h2>
        <div className="mt-4 space-y-4">
          {faqEntries.map((e) => (
            <details
              key={e.q}
              className="border border-rule rounded-lg px-4 py-3"
            >
              <summary className="cursor-pointer text-sm font-medium text-ink leading-tight">
                {e.q}
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                {e.a}
              </p>
            </details>
          ))}
        </div>
      </section>

      {relatedPairs.length > 0 && (
        <section className="mt-12 max-w-3xl">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
            Related comparisons
          </h2>
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
            {relatedPairs.map((p) => {
              const nameA = canonicalize(p.providerA).name;
              const nameB = canonicalize(p.providerB).name;
              return (
                <li key={p.slug}>
                  <Link
                    href={`/compare/${p.slug}`}
                    className="text-sm text-ink-soft hover:text-ink lnk"
                  >
                    {nameA} vs {nameB}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="mt-12 max-w-3xl">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          How this pair was selected
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Auto-generated pairs require: both providers in the same
          benchmark for seven consecutive days, at least 1000 samples
          per provider, observable third-party search demand, and a
          public <code>/products/[slug]</code> page on OCB. Editorially
          curated pairs (like this one) may publish early when search
          demand is high and data is accruing; panels with fewer than
          100 samples are shown as provisional. The full pair ledger is
          versioned in the public repo.
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

