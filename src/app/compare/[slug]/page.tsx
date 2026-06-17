import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, ChevronRight } from "lucide-react";
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
import type { Benchmark } from "@/types/benchmark";

/**
 * Compare pages reuse the parent benchmarks' Prom data, so freshness
 * inherits 1:1 from the underlying benches. ISR window matches the
 * /products/[slug] page because the same provider appearances back both.
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
async function resolveAdHocPair(slug: string): Promise<ComparePair | null> {
  const parsed = parseAdHocSlug(slug);
  if (!parsed) return null;
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

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const pair = getComparePair(slug) ?? (await resolveAdHocPair(slug));
  if (!pair) return {};
  const { a, b } = await loadPairProviders(pair);
  if (!a || !b) return {};

  const url = `${SITE.url}/compare/${pair.slug}`;
  const title = `${a.name} vs ${b.name}: live OpenChainBench benchmark data`;
  const description = capDescription(
    `${a.name} vs ${b.name} side by side on every shared OpenChainBench benchmark. Live measurements, identical layout, no verdict.`,
    158,
  );

  return {
    title,
    description,
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
 *  Rendered as a collapsible disclosure: chain row always visible, the
 *  region rows reveal on click via native <details>. */
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
   *  renderer uses this nested structure (collapsible per chain) and
   *  drops the flat chainBreakdown + regionBreakdown so the side by
   *  side stays compact instead of stacking two separate tables. */
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

  const entries = await Promise.all(
    chains.map(async (c) => {
      const chainVariant = await loadBenchmark(benchSlug, {
        chain: c.value,
      });
      if (!chainVariant) return null;
      const aChain = chainVariant.results.find((r) => r.slug === providerA);
      const bChain = chainVariant.results.find((r) => r.slug === providerB);
      if (!aChain || !bChain) return null;
      if (aChain.ms.p50 <= 0 || bChain.ms.p50 <= 0) return null;
      const chainWinner = decideWinner(
        aChain.ms.p50,
        bChain.ms.p50,
        higherIsBetter,
      );

      const regionRows = await Promise.all(
        regions.map(async (r) => {
          const variant = await loadBenchmark(benchSlug, {
            chain: c.value,
            region: r.value,
          });
          if (!variant) return null;
          const aRes = variant.results.find((x) => x.slug === providerA);
          const bRes = variant.results.find((x) => x.slug === providerB);
          if (!aRes || !bRes) return null;
          if (aRes.ms.p50 <= 0 || bRes.ms.p50 <= 0) return null;
          const winner = decideWinner(
            aRes.ms.p50,
            bRes.ms.p50,
            higherIsBetter,
          );
          return {
            value: r.value,
            label: r.label,
            aP50: aRes.ms.p50,
            bP50: bRes.ms.p50,
            aWins: winner === "a",
            bWins: winner === "b",
          } satisfies BreakdownRow;
        }),
      );
      const cleanRegionRows = regionRows.filter(
        (r): r is BreakdownRow => r !== null,
      );

      return {
        value: c.value,
        label: c.label,
        aP50: aChain.ms.p50,
        bP50: bChain.ms.p50,
        aWins: chainWinner === "a",
        bWins: chainWinner === "b",
        regionRows: cleanRegionRows,
      } satisfies ChainRegionEntry;
    }),
  );
  return entries.filter((e): e is ChainRegionEntry => e !== null);
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
  return built.filter((b): b is SharedBench => b !== null);
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
    name: `${a.name} vs ${b.name} OpenChainBench measurements`,
    description: `Side by side live measurements for ${a.name} and ${b.name} on ${shared.length} shared OpenChainBench benchmarks.`,
    url,
    creator: { "@id": `${SITE.url}/#org` },
    license: "https://creativecommons.org/licenses/by/4.0/",
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
          Side by side OpenChainBench measurements. Identical layout, no
          editorial verdict, the live data leads. Each panel surfaces
          the aggregate plus the chain and region breakdowns when the
          underlying bench exposes them, straight from the Prometheus
          queries that drive the parent benchmark pages.
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
        <ChainRegionMatrixTable
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

/** Nested per chain x per region grid used when a bench exposes both
 *  dimensions. Each chain row is a native <details> disclosure: the
 *  chain summary is always visible, click the chevron to reveal the
 *  region sub-rows scoped to that chain. CSS grid with `display:
 *  contents` on <details> + <summary> keeps the columns aligned
 *  through the disclosure structure with zero JS. */
function ChainRegionMatrixTable({
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
  return (
    <div className="mt-6 border-t border-rule pt-4">
      <p className="text-[11px] uppercase tracking-[0.18em] text-ink-muted font-medium mb-3">
        Per chain · click to expand regions
      </p>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-sm tabular">
        <div className="text-[10px] uppercase tracking-[0.16em] text-ink-faint pb-2 border-b border-rule">
          Chain
        </div>
        <div className="text-[10px] uppercase tracking-[0.16em] text-ink-faint pb-2 border-b border-rule text-right">
          {aName}
        </div>
        <div className="text-[10px] uppercase tracking-[0.16em] text-ink-faint pb-2 border-b border-rule text-right">
          {bName}
        </div>
        {entries.map((entry) => (
          <details
            key={entry.value}
            className="contents [&>summary>.chev]:transition-transform [&[open]>summary>.chev]:rotate-90"
          >
            <summary className="contents cursor-pointer marker:hidden [&::-webkit-details-marker]:hidden">
              <div className="py-2 text-ink-soft flex items-center gap-1.5 hover:text-ink border-b border-rule/40">
                <ChevronRight
                  size={12}
                  strokeWidth={2}
                  className="chev text-ink-faint shrink-0"
                />
                <span>{entry.label}</span>
                {entry.regionRows.length > 0 && (
                  <span className="text-[10px] text-ink-faint normal-case tracking-normal ml-1">
                    ({entry.regionRows.length} region
                    {entry.regionRows.length === 1 ? "" : "s"})
                  </span>
                )}
              </div>
              <div
                className={`py-2 text-right border-b border-rule/40 ${entry.aWins ? "text-good font-medium" : entry.bWins ? "text-bad" : "text-ink"}`}
              >
                {fmtUnit(entry.aP50, unit)}
              </div>
              <div
                className={`py-2 text-right border-b border-rule/40 ${entry.bWins ? "text-good font-medium" : entry.aWins ? "text-bad" : "text-ink"}`}
              >
                {fmtUnit(entry.bP50, unit)}
              </div>
            </summary>
            {entry.regionRows.map((r) => (
              <div key={r.value} className="contents">
                <div className="py-1.5 pl-7 text-xs text-ink-muted border-b border-rule/20">
                  {r.label}
                </div>
                <div
                  className={`py-1.5 text-right text-xs border-b border-rule/20 ${r.aWins ? "text-good" : r.bWins ? "text-bad" : "text-ink-muted"}`}
                >
                  {fmtUnit(r.aP50, unit)}
                </div>
                <div
                  className={`py-1.5 text-right text-xs border-b border-rule/20 ${r.bWins ? "text-good" : r.aWins ? "text-bad" : "text-ink-muted"}`}
                >
                  {fmtUnit(r.bP50, unit)}
                </div>
              </div>
            ))}
          </details>
        ))}
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
