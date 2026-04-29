import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import {
  formatLastRun,
  getBenchmark,
  getBenchmarks,
  getBenchmarkSlugs,
} from "@/data/benchmarks";
import { Byline } from "@/components/byline";
import { TimeSeriesChart } from "@/components/time-series-chart";
import { RangeChart } from "@/components/range-chart";
import { LedgerTable } from "@/components/ledger-table";
import { RegionGrid } from "@/components/region-grid";
import { Figure } from "@/components/figure";
import { BigNumber } from "@/components/big-number";
import { SectionRule } from "@/components/section-rule";
import { fmtUnit, unitSuffix } from "@/lib/format";

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
  return {
    title: b.title,
    description: b.subtitle,
    openGraph: { title: b.title, description: b.subtitle, type: "article" },
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
  const successes = benchmark.results.map((r) => r.successRate);

  const fieldMin = p50s.length ? Math.min(...p50s) : 0;
  const fieldMax = p50s.length ? Math.max(...p50s) : 0;
  const fieldMedian = p50s.length
    ? [...p50s].sort((a, b) => a - b)[Math.floor(p50s.length / 2)]
    : 0;
  const tailMin = p99s.length ? Math.min(...p99s) : 0;
  const tailMax = p99s.length ? Math.max(...p99s) : 0;
  const tailSpread = tailMin > 0 ? tailMax / tailMin : 0;
  const successAvg =
    successes.length ? successes.reduce((s, v) => s + v, 0) / successes.length : 0;
  const successWorst = successes.length ? Math.min(...successes) : 0;

  return (
    <article className="mx-auto max-w-4xl px-6 pt-12 sm:pt-16">
      <Link
        href="/benchmarks"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={2} />
        All benchmarks
      </Link>

      <div className="mt-7 flex items-center gap-3">
        <span className="benchmark-mark">
          № {benchmark.number} · {benchmark.category}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-rule px-2.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              isDraft ? "bg-ink-faint" : "bg-good animate-pulse"
            }`}
          />
          {isDraft ? "Draft" : "Live"}
        </span>
      </div>

      <h1 className="mt-4 display text-4xl sm:text-5xl md:text-6xl">
        {benchmark.title}
      </h1>
      <p className="mt-5 editorial text-xl sm:text-2xl text-ink-soft leading-snug">
        {benchmark.subtitle}
      </p>

      <div className="mt-8">
        <Byline
          number={benchmark.number}
          category={benchmark.category}
          lastRunAt={benchmark.lastRunAt}
          sampleSize={benchmark.sampleSize}
        />
      </div>

      {isDraft ? (
        <DraftNotice source={benchmark.source} />
      ) : (
        <div className="mt-10 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-rule rounded overflow-hidden border border-rule">
          <BigNumber
            label="Field min · p50"
            value={fmtUnit(fieldMin, benchmark.unit).replace(/\s+\S+$/, "")}
            unit={unitSuffix(benchmark.unit).trim()}
            caption="Lowest provider median"
          />
          <BigNumber
            label="Field median · p50"
            value={fmtUnit(fieldMedian, benchmark.unit).replace(/\s+\S+$/, "")}
            unit={unitSuffix(benchmark.unit).trim()}
            caption={`Median across ${benchmark.results.length} providers`}
          />
          <BigNumber
            label="Field max · p50"
            value={fmtUnit(fieldMax, benchmark.unit).replace(/\s+\S+$/, "")}
            unit={unitSuffix(benchmark.unit).trim()}
            caption="Highest provider median"
          />
          <BigNumber
            label="Tail spread (p99)"
            value={tailSpread > 0 ? `${tailSpread.toFixed(1)}×` : "—"}
            caption={
              tailSpread > 0
                ? `${fmtUnit(tailMin, benchmark.unit)} → ${fmtUnit(tailMax, benchmark.unit)}`
                : "n/a"
            }
          />
          <BigNumber
            label="Success · field avg"
            value={`${successAvg.toFixed(2)}%`}
            caption={`Worst ${successWorst.toFixed(2)}%`}
          />
          <BigNumber
            label="Sample size · 24h"
            value={Math.round(benchmark.sampleSize).toLocaleString()}
            caption={`${benchmark.results.length} providers`}
          />
        </div>
      )}

      <SectionRule label="Abstract" />
      <p className="text-base sm:text-lg leading-relaxed text-ink-soft max-w-3xl">
        {benchmark.abstract}
      </p>

      {!isDraft && (
        <>
          <SectionRule label="Time series" />
          <Figure
            number="1"
            title={`${benchmark.metric} over the last 24 hours`}
            source={`Cross-region p50 per provider · resampled at 20-minute resolution`}
            note={
              <>
                Each line is one provider&apos;s rolling-1h p50 evaluated every 20 minutes. Lower is better. The same Y-axis is shared across providers — magnitudes are directly comparable.
              </>
            }
          >
            <TimeSeriesChart benchmark={benchmark} />
          </Figure>

          <SectionRule label="Distribution" />
          <Figure
            number="2"
            title={`${benchmark.metric} (p50, p90, p99) by provider`}
            source={`Run ${formatLastRun(benchmark.lastRunAt)} · ${Math.round(benchmark.sampleSize).toLocaleString()} samples`}
            note={
              <>
                Lower is better. Range is p50 → p99; dashed line is field median. Failed requests are excluded from latency aggregates and counted toward success rate.
              </>
            }
          >
            <RangeChart results={benchmark.results} unit={benchmark.unit} />
          </Figure>

          <SectionRule label="Full ledger" />
          <Figure
            number="3"
            title="Distribution, range, reliability and 24-hour trend"
            source="Cross-region medians, all providers · sorted ascending by p50"
            note={
              <>
                Twelve columns: percentile aggregates, the 24-hour observed range (min/max), the delta of each provider&apos;s p50 versus the field mean, success rate, sample count, and a sparkline. Sparklines share a common Y-axis.
              </>
            }
          >
            <LedgerTable benchmark={benchmark} />
          </Figure>

          {Object.keys(benchmark.extras.regions).length > 0 && (
            <>
              <SectionRule label="By region" />
              <Figure
                number="4"
                title="p50 latency by region — small multiples"
                source="Per-region cross-section"
                note={
                  <>
                    Each region is independently scaled to its own maximum so the ranking is read across, not across regions.
                  </>
                }
              >
                <RegionGrid benchmark={benchmark} />
              </Figure>
            </>
          )}
        </>
      )}

      {benchmark.findings.length > 0 && !isDraft && (
        <>
          <SectionRule label="Findings" />
          <ol className="space-y-5">
            {benchmark.findings.map((f, i) => (
              <li key={i} className="flex gap-4">
                <span className="font-mono text-xs tabular text-ink-faint mt-1.5 w-7 shrink-0">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <p className="text-base leading-relaxed text-ink-soft">{f}</p>
              </li>
            ))}
          </ol>
        </>
      )}

      <SectionRule label="Methodology" />
      <ul className="space-y-3 text-base leading-relaxed text-ink-soft">
        {benchmark.methodology.map((m) => (
          <li key={m} className="flex gap-3">
            <span className="text-ink-faint mt-1.5">—</span>
            <span>{m}</span>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-[11px] uppercase tracking-[0.14em] text-ink-muted">
        Source code:{" "}
        <a className="lnk" href={benchmark.source}>
          {benchmark.source.replace("https://github.com/", "")}
        </a>
      </p>

      {!isDraft && (
        <>
          <SectionRule label="Cite this report" />
          <pre className="card font-mono text-[11px] leading-relaxed bg-paper-soft p-5 overflow-x-auto whitespace-pre-wrap">
{`@misc{openchainbench-${benchmark.number},
  author       = {{OpenChainBench}},
  title        = {${benchmark.title}},
  year         = {${new Date(benchmark.lastRunAt).getFullYear()}},
  howpublished = {\\url{https://openchainbench.xyz/benchmarks/${benchmark.slug}}},
  note         = {Run on ${formatLastRun(benchmark.lastRunAt)}}
}`}
          </pre>
        </>
      )}

      {otherBenchmarks.length > 0 && (
        <nav className="mt-20 border-t border-rule pt-8 -mx-2">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted px-2">
            More benchmarks
          </h3>
          <ul className="mt-5 grid gap-4 sm:grid-cols-2 items-stretch px-2">
            {otherBenchmarks.map((b) => (
              <li key={b.slug} className="flex">
                <Link
                  href={`/benchmarks/${b.slug}`}
                  className="flex-1 card-soft p-5 flex flex-col"
                >
                  <p className="benchmark-mark">
                    № {b.number} · {b.category}
                  </p>
                  <p className="mt-3 display text-lg font-bold leading-tight">
                    {b.title}
                  </p>
                  <p className="mt-2 editorial text-sm text-ink-muted line-clamp-2 flex-1">
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

function DraftNotice({ source }: { source: string }) {
  return (
    <div className="mt-10 card p-6 sm:p-8">
      <p className="eyebrow">Draft — Awaiting first run</p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft max-w-2xl">
        The spec for this benchmark is published but the harness has not emitted enough data yet. The methodology below describes what will be measured. The page will switch to live data on the next ISR revalidation once Prometheus has results.
      </p>
      <p className="mt-4 text-xs text-ink-muted">
        Watch the harness:{" "}
        <a className="lnk text-ink-soft" href={source}>
          {source.replace("https://github.com/", "")}
        </a>
      </p>
    </div>
  );
}
