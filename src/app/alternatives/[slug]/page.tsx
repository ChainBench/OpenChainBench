import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { Pill } from "@/components/pill";
import { TimeSeriesChart } from "@/components/time-series-chart";
import { LedgerTable } from "@/components/ledger-table";
import { CountLeaderboard } from "@/components/count-leaderboard";
import { ShareSection } from "@/components/share-section";
import { fmtUnit, unitSuffix, fmtValue } from "@/lib/format";
import { computeFieldStats } from "@/lib/stats";
import { SectionLabel, SummaryStat } from "@/components/summary-stat";
import { SITE } from "@/data/site";
import { loadAlternative, loadAlternativeSlugs } from "@/lib/alternatives";

export const revalidate = 60;

type Params = { slug: string };

export async function generateStaticParams() {
  const slugs = await loadAlternativeSlugs();
  return slugs.map((slug) => ({ slug }));
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

  return (
    <article className="mx-auto max-w-5xl px-6 pt-10 sm:pt-14">
      <Link
        href="/#latest"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={2} />
        All benchmarks
      </Link>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Pill variant="category">Alternatives</Pill>
        <span className="ml-auto font-mono text-[11px] tabular text-ink-muted">
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
        <p className="mt-4 text-xs text-ink-muted">
          About {alt.target_product}:{" "}
          <a className="lnk" href={alt.target_url} target="_blank" rel="noopener noreferrer">
            {alt.target_url.replace(/^https?:\/\//, "")}
            <ArrowUpRight size={11} strokeWidth={2} className="inline ml-0.5" />
          </a>
        </p>
      )}

      {/* Reuse bench rendering. count vs latency split, same as the
          /benchmarks/[slug] page. */}
      {!isDraft && bench.unit === "count" && (
        <>
          <CountLeaderboard benchmark={bench} />
          <div className="mt-14">
            <SectionLabel>Provider ledger</SectionLabel>
            <LedgerTable benchmark={bench} />
          </div>
        </>
      )}

      {!isDraft && bench.unit !== "count" && (
        <>
          <dl className="mt-10 grid grid-cols-2 sm:flex sm:flex-wrap items-baseline gap-x-8 gap-y-3 border-y border-rule py-4">
            <SummaryStat
              label="Best"
              value={`${fmtValue(fieldMin, bench.unit)}${unitSuffix(bench.unit)}`}
            />
            <SummaryStat
              label="Median"
              value={`${fmtValue(fieldMedian, bench.unit)}${unitSuffix(bench.unit)}`}
            />
            <SummaryStat
              label="Worst"
              value={`${fmtValue(fieldMax, bench.unit)}${unitSuffix(bench.unit)}`}
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
            <SectionLabel>Provider ledger · sorted by p50</SectionLabel>
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

      {!isDraft && (
        <div className="mt-10">
          <ShareSection
            slug={`${bench.slug}`}
            title={`${alt.target_product} alternatives`}
            benchmark={bench}
          />
        </div>
      )}
    </article>
  );
}

