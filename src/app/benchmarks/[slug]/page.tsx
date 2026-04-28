import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  formatLastRun,
  getBenchmark,
  getBenchmarks,
  getBenchmarkSlugs,
  getLeader,
} from "@/data/benchmarks";
import { Byline } from "@/components/byline";
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
  const leader = getLeader(benchmark);
  const otherBenchmarks = all.filter((b) => b.slug !== benchmark.slug);

  const fieldP50 = isDraft
    ? 0
    : benchmark.results.reduce((s, r) => s + r.ms.p50, 0) /
      benchmark.results.length;
  const advantage = leader
    ? ((fieldP50 - leader.ms.p50) / fieldP50) * 100
    : 0;
  const worstP99 = isDraft
    ? 0
    : Math.max(...benchmark.results.map((r) => r.ms.p99));
  const tailMultiple = leader && worstP99 > 0 ? worstP99 / leader.ms.p99 : 0;

  return (
    <article className="mx-auto max-w-4xl px-6 py-10">
      <p className="font-sans text-[11px] uppercase tracking-[0.22em] text-accent">
        Bench №&nbsp;{benchmark.number} · {benchmark.category}
      </p>
      <h1 className="mt-3 font-serif text-4xl sm:text-5xl md:text-6xl font-bold leading-[1.02] tracking-tight">
        {benchmark.title}
      </h1>
      <p className="mt-4 font-serif italic text-xl text-ink-soft max-w-3xl">
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
        <>
          {leader && (
            <blockquote className="my-10 border-l-4 border-ink pl-6 py-2">
              <p className="font-serif text-2xl sm:text-3xl leading-snug">
                <span className="font-semibold">{leader.name}</span> leads at{" "}
                <span className="mark font-mono tabular">
                  {fmtUnit(leader.ms.p50, benchmark.unit)}
                </span>{" "}
                <span className="text-ink-soft italic">(p50)</span>
                {advantage > 0 && (
                  <>
                    {" "}— about {Math.round(advantage)}% under the field median.
                  </>
                )}
                .
              </p>
              <footer className="mt-2 font-sans text-[11px] uppercase tracking-[0.18em] text-ink-muted">
                Across {benchmark.results.length} providers ·{" "}
                {benchmark.sampleSize.toLocaleString()} samples
              </footer>
            </blockquote>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-rule border border-ink">
            <BigNumber
              emphasis
              label={`${leader?.name ?? "Lead"} · p50`}
              value={fmtUnit(leader?.ms.p50 ?? 0, benchmark.unit).replace(
                /\s.*/,
                ""
              )}
              unit={unitSuffix(benchmark.unit)}
              caption={
                benchmark.unit === "bps"
                  ? "Cross-route median fee"
                  : "Cross-region median latency"
              }
            />
            <BigNumber
              label="Field median"
              value={fmtUnit(fieldP50, benchmark.unit).replace(/\s.*/, "")}
              unit={unitSuffix(benchmark.unit)}
              caption={`Median across ${benchmark.results.length} providers`}
            />
            <BigNumber
              label="Tail spread (p99)"
              value={tailMultiple > 0 ? `${tailMultiple.toFixed(1)}×` : "—"}
              caption={
                tailMultiple > 0 && leader
                  ? `Worst p99 ${fmtUnit(worstP99, benchmark.unit)} vs lead ${fmtUnit(leader.ms.p99, benchmark.unit)}`
                  : "n/a"
              }
            />
          </div>
        </>
      )}

      <SectionRule label="Abstract" number="i" />
      <p className="font-serif text-[1.08rem] leading-[1.7] dropcap">
        {benchmark.abstract}
      </p>

      {!isDraft && (
        <>
          <SectionRule label="Distribution" number="ii" />
          <Figure
            number="1"
            title={`${benchmark.metric} (p50, p90, p99) by provider`}
            source={`Run ${formatLastRun(benchmark.lastRunAt)} · ${benchmark.sampleSize.toLocaleString()} samples`}
            note={
              <>
                Lower is better. Range is p50 → p99; dashed line is field
                median. Failed requests are excluded from latency aggregates
                and counted toward success rate (Table 1).
              </>
            }
          >
            <RangeChart results={benchmark.results} unit={benchmark.unit} />
          </Figure>

          <SectionRule label="Full ledger" number="iii" />
          <Figure
            number="2"
            title="Latency, reliability and 24-hour trend"
            source="Cross-region medians, all providers"
            note={
              <>
                Sparklines plot p50 over the last 24 hours, on a shared
                Y-axis so magnitudes are comparable. The lead row is shaded.
              </>
            }
          >
            <LedgerTable benchmark={benchmark} />
          </Figure>

          {Object.keys(benchmark.extras.regions).length > 0 && (
            <>
              <SectionRule label="By region" number="iv" />
              <Figure
                number="3"
                title="p50 latency by region"
                source="Per-region cross-section"
                note={
                  <>
                    Each region is independently scaled to its own maximum
                    so the ranking is read across, not across regions.
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
          <SectionRule label="Findings" number="v" />
          <ol className="space-y-5">
            {benchmark.findings.map((f, i) => (
              <li key={i} className="flex gap-4">
                <span className="font-serif text-3xl font-semibold leading-none text-ink-muted shrink-0 w-9">
                  {i + 1}.
                </span>
                <p className="font-serif text-[1.05rem] leading-[1.65]">{f}</p>
              </li>
            ))}
          </ol>
        </>
      )}

      <SectionRule label="Methodology" number="vi" />
      <ul className="space-y-3 font-serif text-[1.02rem] leading-[1.6] text-ink-soft">
        {benchmark.methodology.map((m) => (
          <li key={m} className="flex gap-3">
            <span className="text-ink-muted">—</span>
            <span>{m}</span>
          </li>
        ))}
      </ul>

      <p className="mt-6 font-sans text-[12px] uppercase tracking-[0.18em] text-ink-soft">
        Source code:{" "}
        <a className="lnk" href={benchmark.source}>
          {benchmark.source.replace("https://github.com/", "")}
        </a>
      </p>

      {!isDraft && (
        <>
          <SectionRule label="Cite this report" number="vii" />
          <pre className="font-mono text-[11px] leading-snug bg-paper-deep border border-rule p-4 overflow-x-auto whitespace-pre-wrap">
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
        <nav className="mt-16 border-t-2 border-ink pt-6">
          <h3 className="font-sans text-[11px] uppercase tracking-[0.22em] text-ink-muted">
            More benchmarks
          </h3>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {otherBenchmarks.map((b) => (
              <li key={b.slug}>
                <Link
                  href={`/benchmarks/${b.slug}`}
                  className="block border border-rule bg-paper-deep/50 p-4 hover:border-ink"
                >
                  <p className="font-sans text-[10px] uppercase tracking-[0.18em] text-ink-muted">
                    Bench №&nbsp;{b.number}
                  </p>
                  <p className="mt-1 font-serif text-lg font-semibold leading-snug">
                    {b.title}
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
    <div className="my-10 border-2 border-dashed border-ink/40 bg-paper-deep/40 p-6">
      <p className="font-sans text-[11px] uppercase tracking-[0.22em] text-ink">
        Draft — Awaiting first run
      </p>
      <p className="mt-3 font-serif text-[1.05rem] leading-relaxed text-ink-soft">
        The spec for this benchmark is published, but the harness has not
        emitted enough data yet to show numbers. The methodology below
        describes what will be measured and how. Once the harness pushes
        results to Prometheus, this page will switch to live data on the
        next revalidation.
      </p>
      <p className="mt-3 font-sans text-[11px] uppercase tracking-[0.18em] text-ink-muted">
        Watch the harness:{" "}
        <a className="lnk normal-case tracking-normal" href={source}>
          {source.replace("https://github.com/", "")}
        </a>
      </p>
    </div>
  );
}
