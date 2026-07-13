import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { Pill } from "@/components/pill";
import { TimeSeriesChart } from "@/components/time-series-chart";
import { LedgerTable } from "@/components/ledger-table";
import { CountLeaderboard } from "@/components/count-leaderboard";
import { fmtUnit, unitSuffix, fmtValue } from "@/lib/format";
import { computeFieldStats } from "@/lib/stats";
import { getBenchCreatedAt } from "@/lib/seo/bench-dates";
import { capDescription } from "@/lib/seo-text";
import { SectionLabel, SummaryStat } from "@/components/summary-stat";
import { SITE } from "@/data/site";
import { loadAlternative } from "@/lib/alternatives";
import { Breadcrumb } from "@/components/breadcrumb";
import { buildBreadcrumbJsonLd, safeJsonLd } from "@/lib/jsonld";
import { citableAsOf } from "@/lib/citation";
import { ProviderLogo } from "@/components/provider-logo";
import { ProviderTypeBadge } from "@/components/provider-type-badge";
import { isRegion } from "@/lib/brand";

export const revalidate = 60;

// Same budget as /products/[slug]: on-demand renders span the whole bench
// catalog and the 60s default killed them mid-flight.
export const maxDuration = 300;

type Params = { slug: string };

// Rendered ON DEMAND (first request, then ISR-cached), same reasoning as
// /products/[slug]: prerendering these at build multiplies the full
// multi-bench Prom load per build worker and blew the page budget.
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return [];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const alt = await loadAlternative(slug);
  if (!alt) return {};
  const title =
    alt.seo_title ??
    `${alt.target_product} alternatives. live benchmark · OpenChainBench`;
  const description = alt.seo_description ?? alt.intro.slice(0, 200);
  const url = `${SITE.url}/alternatives/${alt.slug}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, type: "article", url },
  };
}

export default async function AlternativePage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const alt = await loadAlternative(slug);
  if (!alt) notFound();

  const { bench } = alt;
  const isDraft = bench.status === "draft";
  const { fieldMin, fieldMedian, fieldMax, tailMin, tailMax, tailSpread } =
    computeFieldStats(bench.results);

  // Top alternatives = leading bench results, excluding the target product
  // itself, region pseudo-slugs, and any zero-data fallback rows (Prom miss
  // at build time renders p50=0 for every provider - drop those instead of
  // showing "0%" cards).
  const targetSlug = alt.target_product.toLowerCase().replace(/\s+/g, "-");
  const sortedResults = [...bench.results]
    .filter((r) => !isRegion(r.slug))
    .filter((r) => r.slug.toLowerCase() !== targetSlug)
    .filter((r) => r.ms.p50 > 0 || r.ms.p99 > 0)
    .sort((a, b) =>
      bench.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
    );
  const topAlternatives = sortedResults.slice(0, 5);

  const url = `${SITE.url}/alternatives/${alt.slug}`;
  const benchUrl = `${SITE.url}/benchmarks/${bench.slug}`;

  // Schema.org / Google Rich Results requires Dataset.description to be
  // between 50 and 5000 chars (Search Console flags "Invalid string
  // length" below 50). Most short alt.description fields ("Relay
  // alternatives", ~40 chars) trip this. Pad with bench context until
  // the threshold is met, then truncate at the 5000 ceiling.
  const altDescriptionBase = alt.description ?? alt.intro.slice(0, 280);
  const altDescriptionPadded = (() => {
    if (altDescriptionBase.length >= 50) return altDescriptionBase.slice(0, 5000);
    const altCount = topAlternatives.length;
    const peers = altCount > 0
      ? `${altCount} live alternative${altCount === 1 ? "" : "s"}`
      : "live alternatives";
    const pad = `. Open benchmark snapshot of ${alt.target_product} versus ${peers} on ${bench.metric}, measured continuously and published with full methodology.`;
    const joined = `${altDescriptionBase}${pad}`;
    return joined.slice(0, 5000);
  })();

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Dataset",
        "@id": `${url}#dataset`,
        name: `${alt.target_product} alternatives, benchmark snapshot`,
        description: capDescription(altDescriptionPadded, 990),
        url,
        identifier: alt.slug,
        keywords: [
          `${alt.target_product} alternatives`,
          bench.category,
          bench.metric,
          ...bench.results.map((r) => r.name),
        ].join(", "),
        creator: { "@id": `${SITE.url}/#org` },
        publisher: { "@id": `${SITE.url}/#org` },
        isAccessibleForFree: true,
        license: "https://creativecommons.org/licenses/by/4.0/",
        datePublished: getBenchCreatedAt(bench.slug).toISOString(),
        ...(citableAsOf(bench) ? { dateModified: bench.lastRunAt } : {}),
        variableMeasured: bench.metric,
        isBasedOn: benchUrl,
      },
      {
        "@type": "Article",
        "@id": `${url}#article`,
        headline: `${alt.target_product} alternatives`,
        description: capDescription(altDescriptionPadded, 990),
        url,
        mainEntityOfPage: url,
        articleBody: alt.intro,
        datePublished: getBenchCreatedAt(bench.slug).toISOString(),
        ...(citableAsOf(bench) ? { dateModified: bench.lastRunAt } : {}),
        author: { "@id": `${SITE.url}/#org` },
        publisher: { "@id": `${SITE.url}/#org` },
        about: { "@id": `${url}#dataset` },
      },
      buildBreadcrumbJsonLd([
        { name: "Home", item: SITE.url },
        { name: "Alternatives", item: `${SITE.url}/alternatives` },
        { name: `${alt.target_product} alternatives`, item: url },
      ]),
    ],
  };

  return (
    <article className="mx-auto max-w-5xl px-6 pt-10 sm:pt-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      {/* Visible breadcrumb trail - mirrors the BreadcrumbList JSON-LD above. */}
      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          { label: "Alternatives", href: "/alternatives" },
          { label: `${alt.target_product} alternatives` },
        ]}
      />

      <Link
        href="/#latest"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={2} />
        All benchmarks
      </Link>

      <div className="mt-6 flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2">
        <Pill variant="category">Alternatives</Pill>
        <span className="sm:ml-auto font-sans tabular text-[11px] text-ink-muted">
          Sourced from {bench.title}
        </span>
      </div>

      <h1 className="mt-5 display text-2xl sm:text-3xl md:text-4xl tracking-tight">
        {alt.target_product} alternatives
      </h1>
      <p className="mt-3 max-w-3xl text-base text-ink-soft leading-snug">
        {alt.description}
      </p>

      <div className="mt-6 max-w-3xl border-y border-rule py-4 text-base leading-relaxed text-ink-soft">
        {alt.intro}
      </div>

      {alt.target_url && (
        <p className="mt-4 text-xs text-ink-muted break-words">
          About {alt.target_product}:{" "}
          <a className="lnk break-all" href={alt.target_url} target="_blank" rel="noopener noreferrer">
            {alt.target_url.replace(/^https?:\/\//, "")}
            <ArrowUpRight size={11} strokeWidth={2} className="inline ml-0.5 shrink-0" />
          </a>
        </p>
      )}

      {/* Top alternatives cards - explicit list with internal links to
          product pages. The bench leaderboard below carries the full data;
          this section frames the answer for skim-readers and search. */}
      {topAlternatives.length > 0 && (
        <section className="mt-10">
          <SectionLabel>
            Top {topAlternatives.length} {alt.target_product} alternatives
          </SectionLabel>
          <ol className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {topAlternatives.map((r, i) => (
              <li key={r.slug}>
                <Link
                  href={`/products/${r.slug}`}
                  className="card-soft rounded-xl p-4 flex flex-col gap-2 h-full hover:border-ink/40 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <ProviderLogo slug={r.slug} name={r.name} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-ink leading-tight truncate">
                        {r.name}
                      </p>
                      <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint font-medium">
                        #{i + 1} · {bench.metric}
                      </p>
                    </div>
                    {r.type && <ProviderTypeBadge type={r.type} />}
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-ink">
                    <span className="font-sans tabular text-lg font-semibold">
                      {fmtValue(r.ms.p50, bench.unit)}
                    </span>
                    <span className="font-sans text-[11px] text-ink-muted">
                      {unitSuffix(bench.unit, r.ms.p50).trim()}
                    </span>
                    <span className="w-full sm:w-auto sm:ml-auto text-[11px] text-ink-faint">
                      p99 {fmtUnit(r.ms.p99, bench.unit)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Reuse bench rendering. count vs latency split, same as the
          /benchmarks/[slug] page. */}
      {!isDraft && bench.unit === "count" && (
        <>
          <CountLeaderboard benchmark={bench} />
          <div className="mt-14">
            <SectionLabel>Product ledger</SectionLabel>
            <LedgerTable benchmark={bench} />
          </div>
        </>
      )}

      {!isDraft && bench.unit !== "count" && (
        <>
          <dl className="mt-10 grid grid-cols-2 sm:flex sm:flex-wrap items-baseline gap-x-8 gap-y-3 border-y border-rule py-4">
            <SummaryStat
              label="Best"
              value={`${fmtValue(bench.higherIsBetter ? fieldMax : fieldMin, bench.unit)}${unitSuffix(bench.unit, bench.higherIsBetter ? fieldMax : fieldMin)}`}
            />
            <SummaryStat
              label="Median"
              value={`${fmtValue(fieldMedian, bench.unit)}${unitSuffix(bench.unit, fieldMedian)}`}
            />
            <SummaryStat
              label="Worst"
              value={`${fmtValue(bench.higherIsBetter ? fieldMin : fieldMax, bench.unit)}${unitSuffix(bench.unit, bench.higherIsBetter ? fieldMin : fieldMax)}`}
            />
            <SummaryStat
              label="Spread"
              value={tailSpread > 0 ? `${tailSpread.toFixed(1)}×` : "-"}
              hint={
                tailSpread > 0
                  ? `${fmtUnit(tailMin, bench.unit)} → ${fmtUnit(tailMax, bench.unit)}`
                  : undefined
              }
            />
            <SummaryStat
              label="Samples · 24h"
              value={Math.round(bench.sampleSize).toLocaleString()}
              hint={`${bench.results.length} providers`}
            />
          </dl>

          <div className="mt-12">
            <SectionLabel>{bench.metric} · last 24 hours</SectionLabel>
            <TimeSeriesChart benchmark={bench} />
          </div>

          <div className="mt-14">
            <SectionLabel>Product ledger · sorted by p50</SectionLabel>
            <LedgerTable benchmark={bench} />
          </div>
        </>
      )}

      <p className="mt-12 max-w-2xl text-xs text-ink-muted">
        Same data as{" "}
        <Link href={`/benchmarks/${bench.slug}`} className="lnk text-ink-soft">
          /benchmarks/{bench.slug}
        </Link>
        {alt.chain ? ` (filtered to ${alt.chain})` : ""}, refreshed every minute.
        OpenChainBench is community-run; methodology is open.
      </p>

    </article>
  );
}

