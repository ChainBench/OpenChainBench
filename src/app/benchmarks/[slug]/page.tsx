import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, ChevronDown } from "lucide-react";
import {
  formatLastRun,
  getBenchmark,
  getBenchmarks,
  getBenchmarkSlugs,
} from "@/data/benchmarks";
import { Pill } from "@/components/pill";
import { TimeSeriesChart } from "@/components/time-series-chart";
import { LedgerTable } from "@/components/ledger-table";
import { RegionGrid } from "@/components/region-grid";
import { ShareSection } from "@/components/share-section";
import { CountLeaderboard } from "@/components/count-leaderboard";
import { fmtUnit, unitSuffix, fmtValue } from "@/lib/format";
import { SITE } from "@/data/site";

type Params = { slug: string };

export async function generateStaticParams() {
  const slugs = await getBenchmarkSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const b = await getBenchmark(slug);
  if (!b) return {};
  const metaTitle = b.seoTitle ?? b.title;
  return {
    title: metaTitle,
    description: b.subtitle,
    openGraph: { title: metaTitle, description: b.subtitle, type: "article" },
  };
}

export default async function BenchmarkPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const [benchmark, all] = await Promise.all([
    getBenchmark(slug),
    getBenchmarks(),
  ]);
  if (!benchmark) notFound();

  const isDraft = benchmark.status === "draft";
  const otherBenchmarks = all.filter((b) => b.slug !== benchmark.slug);

  // Field-level neutral KPIs
  const p50s = benchmark.results.map((r) => r.ms.p50);
  const p99s = benchmark.results.map((r) => r.ms.p99);

  const fieldMin = p50s.length ? Math.min(...p50s) : 0;
  const fieldMax = p50s.length ? Math.max(...p50s) : 0;
  const fieldMedian = p50s.length
    ? [...p50s].sort((a, b) => a - b)[Math.floor(p50s.length / 2)]
    : 0;
  const tailMin = p99s.length ? Math.min(...p99s) : 0;
  const tailMax = p99s.length ? Math.max(...p99s) : 0;
  const tailSpread = tailMin > 0 ? tailMax / tailMin : 0;

  const benchmarkUrl = `${SITE.url}/benchmarks/${benchmark.slug}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: benchmark.seoTitle ?? benchmark.title,
    description: benchmark.abstract,
    url: benchmarkUrl,
    keywords: [
      benchmark.category,
      benchmark.metric,
      ...benchmark.results.map((r) => r.name),
      "live benchmark",
      "crypto infrastructure",
    ].join(", "),
    creator: { "@type": "Organization", name: "OpenChainBench", url: SITE.url },
    isAccessibleForFree: true,
    license: "https://creativecommons.org/licenses/by/4.0/",
    dateModified: benchmark.lastRunAt,
    variableMeasured: benchmark.metric,
  };

  return (
    <article className="mx-auto max-w-5xl px-6 pt-10 sm:pt-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Link
        href="/benchmarks"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={2} />
        All benchmarks
      </Link>

      {/* Status row */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Pill variant={isDraft ? "draft" : "live"} pulse>
          {isDraft ? "Draft" : "Live"}
        </Pill>
        <Pill variant="category">{benchmark.category}</Pill>
        <span className="ml-auto font-mono text-[11px] tabular text-ink-muted">
          № {benchmark.number} · Updated {formatLastRun(benchmark.lastRunAt)}
        </span>
      </div>

      {/* Title */}
      <h1 className="mt-5 display text-4xl sm:text-5xl md:text-6xl tracking-tight">
        {benchmark.title}
      </h1>
      <p className="mt-4 max-w-3xl text-lg sm:text-xl text-ink-soft leading-snug">
        {benchmark.subtitle}
      </p>

      {/* Count benches: dedicated leaderboard view (no p50/p90/p99,
          no 24h chart — those are meaningless on a single gauge). */}
      {!isDraft && benchmark.unit === "count" && (
        <>
          <CountLeaderboard benchmark={benchmark} />
          <div className="mt-14">
            <SectionLabel>Provider ledger</SectionLabel>
            <LedgerTable benchmark={benchmark} />
          </div>
        </>
      )}

      {/* Latency / cost benches: thin summary strip + 24h chart. */}
      {!isDraft && benchmark.unit !== "count" && (
        <>
          {/* Thin key-value strip — replaces the 5-BigNumber grid. */}
          <dl className="mt-10 grid grid-cols-2 sm:flex sm:flex-wrap items-baseline gap-x-8 gap-y-3 border-y border-rule py-4">
            <SummaryStat
              label="Best"
              value={`${fmtValue(fieldMin, benchmark.unit)}${unitSuffix(benchmark.unit)}`}
            />
            <SummaryStat
              label="Median"
              value={`${fmtValue(fieldMedian, benchmark.unit)}${unitSuffix(benchmark.unit)}`}
            />
            <SummaryStat
              label="Worst"
              value={`${fmtValue(fieldMax, benchmark.unit)}${unitSuffix(benchmark.unit)}`}
            />
            <SummaryStat
              label="Spread"
              value={tailSpread > 0 ? `${tailSpread.toFixed(1)}×` : "—"}
              hint={
                tailSpread > 0
                  ? `${fmtUnit(tailMin, benchmark.unit)} → ${fmtUnit(tailMax, benchmark.unit)}`
                  : undefined
              }
            />
            <SummaryStat
              label="Samples · 24h"
              value={Math.round(benchmark.sampleSize).toLocaleString()}
              hint={`${benchmark.results.length} providers`}
            />
          </dl>

          <div className="mt-12">
            <SectionLabel>{benchmark.metric} · last 24 hours</SectionLabel>
            <TimeSeriesChart benchmark={benchmark} />
          </div>

          <div className="mt-14">
            <SectionLabel>Provider ledger · sorted by p50</SectionLabel>
            <LedgerTable benchmark={benchmark} />
          </div>

          {Object.keys(benchmark.extras.regions).length > 0 && (
            <div className="mt-14">
              <SectionLabel>By region</SectionLabel>
              <RegionGrid benchmark={benchmark} />
            </div>
          )}
        </>
      )}

      {isDraft && <DraftNotice source={benchmark.source} />}

      {/* Findings (when present) */}
      {benchmark.findings.length > 0 && !isDraft && (
        <div className="mt-14">
          <SectionLabel>Findings</SectionLabel>
          <ol className="mt-2 space-y-4">
            {benchmark.findings.map((f, i) => (
              <li key={i} className="flex gap-4">
                <span className="font-mono text-xs tabular text-ink-faint mt-1.5 w-7 shrink-0">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <p className="text-base leading-relaxed text-ink-soft">{f}</p>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* About. collapsed by default */}
      <details className="mt-14 group border-t border-rule">
        <summary className="flex cursor-pointer items-center justify-between py-4 list-none">
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink">
            About this benchmark
          </span>
          <ChevronDown
            size={16}
            strokeWidth={2}
            className="text-ink-muted transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="pb-6 space-y-6">
          <p className="text-base leading-relaxed text-ink-soft max-w-3xl">
            {benchmark.abstract}
          </p>
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint mb-3">
              Methodology
            </p>
            <ul className="space-y-2 text-sm leading-relaxed text-ink-soft">
              {benchmark.methodology.map((m) => (
                <li key={m} className="flex gap-3">
                  <span className="text-ink-faint mt-1.5">·</span>
                  <span>{m}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>

      {/* Share / export */}
      {!isDraft && (
        <ShareSection
          slug={benchmark.slug}
          title={benchmark.title}
          benchmark={benchmark}
        />
      )}

      {/* Source code link. bottom of page */}
      {!isDraft && (
        <p className="mt-4 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
          Source code{" "}
          <a className="lnk" href={benchmark.source}>
            {benchmark.source.replace("https://github.com/", "github.com/")}
            <ArrowUpRight size={12} strokeWidth={2} className="inline ml-1" />
          </a>
        </p>
      )}

      {/* Other benchmarks */}
      {otherBenchmarks.length > 0 && (
        <nav className="mt-20 border-t border-rule pt-8">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
            More benchmarks
          </h3>
          <ul className="mt-5 grid gap-4 sm:grid-cols-2 items-stretch">
            {otherBenchmarks.map((b) => (
              <li key={b.slug} className="flex">
                <Link
                  href={`/benchmarks/${b.slug}`}
                  className="flex-1 card-soft p-5 flex flex-col"
                >
                  <div className="flex items-center gap-2">
                    <Pill variant={b.status === "live" ? "live" : "draft"} pulse>
                      {b.status === "live" ? "Live" : "Draft"}
                    </Pill>
                    <Pill variant="category">{b.category}</Pill>
                  </div>
                  <p className="mt-3 display text-lg font-bold leading-tight">
                    {b.title}
                  </p>
                  <p className="mt-2 text-sm text-ink-muted line-clamp-2 flex-1">
                    {b.subtitle}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </article>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
      {children}
    </p>
  );
}

/** Thin key-value pair — replaces the BigNumber boxed grid on bench pages.
 * Renders inline: `LABEL  value (hint)`. Used to summarise a benchmark's
 * field stats without the SaaS-dashboard scaffolding. */
function SummaryStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint shrink-0">
        {label}
      </dt>
      <dd className="font-mono tabular text-sm text-ink leading-none">
        {value}
        {hint ? (
          <span className="ml-1.5 text-ink-muted text-xs font-normal">{hint}</span>
        ) : null}
      </dd>
    </div>
  );
}

function DraftNotice({ source }: { source: string }) {
  return (
    <div className="mt-10 card p-6 text-center">
      <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint">
        Draft. no live data yet
      </p>
      <p className="mt-3 text-sm text-ink-muted">
        The spec is published. Numbers will appear here as soon as the harness
        starts emitting metrics.
      </p>
      <a
        href={source}
        className="mt-4 inline-flex items-center gap-1 text-sm font-medium lnk"
      >
        Source code
        <ArrowUpRight size={12} strokeWidth={2} />
      </a>
    </div>
  );
}
