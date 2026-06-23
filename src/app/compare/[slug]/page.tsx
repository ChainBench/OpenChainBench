import type { Metadata } from "next";
import { Fragment } from "react";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { getProvider } from "@/lib/providers";
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
import { pageMetadata } from "@/lib/page-metadata";
import type { Benchmark } from "@/types/benchmark";
import {
  buildSharedBenches,
  canonicalisationTarget,
  fmtTs,
  hasSharedBenches,
  latestIso,
  parseAdHocSlug,
  type BreakdownRow,
  type ChainRegionEntry,
  type Panel,
  type SharedBench,
} from "@/lib/compare-compute";

/**
 * Compare pages reuse the parent benchmarks' Prom data, so freshness
 * inherits 1:1 from the underlying benches. ISR window matches the
 * /products/[slug] page because the same provider appearances back both.
 *
 * 60 s is enough in production because Vercel edge cache serves STALE
 * HTML while ISR regenerates in the background, so a visitor never
 * waits for SSR even when the window expires.
 *
 * Bumped from 60s -> 300s after the Railway egress audit revealed the
 * inflection point on 18 June matched exactly the previous 600s -> 60s
 * revert: 10x more rebuilds = 10x more Prom queries from Vercel = 10x
 * egress bill. /compare is editorial content, not live trading data;
 * 5 min freshness is plenty and matches the unstable_cache TTLs in
 * src/lib/spec.ts (bumped to 300s in the same effort).
 */
export const revalidate = 300;
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

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  // Run the same gating logic as the page render so non-canonical and
  // invalid slugs short-circuit at the metadata phase, BEFORE Next.js
  // streams the loading.tsx fallback. Without this the SSR HTML ends
  // up with the root layout's homepage title and description plus the
  // skeleton body, which is exactly what crawlers index. Routing here
  // produces a real 308 / 404 response from the route layer instead of
  // a 200 wrapping the streamed skeleton.
  const canonicalTarget = canonicalisationTarget(slug);
  if (canonicalTarget) redirect(`/compare/${canonicalTarget}`);
  const pair = getComparePair(slug) ?? (await resolveAdHocPair(slug));
  if (!pair) notFound();
  const { a, b } = await loadPairProviders(pair);
  if (!a || !b) notFound();
  // Final SSR gate: an ad-hoc pair can have both providers resolved yet
  // share zero benches (e.g. an RPC provider vs an oracle). Without
  // this notFound() the page body's `shared.length === 0` check fires
  // after loading.tsx has already streamed the shell, so the response
  // ships HTTP 200 + skeleton + a noindex meta from not-found.tsx —
  // exactly what crawlers indexed before this fix. Cheap: only the
  // appearance intersection, no Prom fan out.
  if (!hasSharedBenches(pair, a, b)) notFound();

  const title = `${a.name} vs ${b.name}: live OpenChainBench benchmark data`;
  const description = capDescription(
    `${a.name} vs ${b.name} side by side on every shared OpenChainBench benchmark. Live measurements, identical layout, no verdict.`,
    158,
  );

  return pageMetadata({
    path: `/compare/${pair.slug}`,
    title,
    description,
  });
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
  const latestTs = latestIso(shared, (s) => s.lastRunAt);

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
        <span className="label-mono-xs shrink-0">
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

      <footer className="mt-5 border-t border-rule pt-3 flex flex-wrap items-center justify-between gap-2 label-mono-xs">
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
            <tr className="label-mono-xs border-b border-rule">
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
            <tr className="label-mono-xs border-b border-rule">
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
