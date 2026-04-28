import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { BENCHMARKS, formatLastRun, getBenchmark } from "@/data/benchmarks";
import { Byline } from "@/components/byline";
import { RangeChart } from "@/components/range-chart";
import { LedgerTable } from "@/components/ledger-table";
import { RegionGrid } from "@/components/region-grid";
import { Figure } from "@/components/figure";
import { BigNumber } from "@/components/big-number";
import { SectionRule } from "@/components/section-rule";
import { fmtUnit } from "@/lib/format";

type Params = { slug: string };

export function generateStaticParams() {
  return BENCHMARKS.map((b) => ({ slug: b.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const b = getBenchmark(slug);
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
  const benchmark = getBenchmark(slug);
  if (!benchmark) notFound();

  const winner = benchmark.results.find((r) => r.highlight === "winner");
  const otherBenchmarks = BENCHMARKS.filter((b) => b.slug !== benchmark.slug);
  const fieldP50 =
    benchmark.results.reduce((s, r) => s + r.ms.p50, 0) / benchmark.results.length;
  const winnerP50 = winner?.ms.p50 ?? benchmark.results[0].ms.p50;
  const advantage = ((fieldP50 - winnerP50) / fieldP50) * 100;
  const worstP99 = Math.max(...benchmark.results.map((r) => r.ms.p99));
  const winnerP99 = winner?.ms.p99 ?? benchmark.results[0].ms.p99;
  const tailMultiple = worstP99 / winnerP99;

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

      {/* Pull quote */}
      {winner && (
        <blockquote className="my-10 border-l-4 border-ink pl-6 py-2">
          <p className="font-serif text-2xl sm:text-3xl leading-snug">
            <span className="font-semibold">{winner.name}</span> leads at{" "}
            <span className="mark font-mono tabular">
              {fmtUnit(winner.ms.p50, benchmark.unit)}
            </span>{" "}
            <span className="text-ink-soft italic">(p50)</span> — about{" "}
            {Math.round(advantage)}% under the field median.
          </p>
          <footer className="mt-2 font-sans text-[11px] uppercase tracking-[0.18em] text-ink-muted">
            Across {benchmark.results.length} providers ·{" "}
            {benchmark.sampleSize.toLocaleString()} samples · 3 regions
          </footer>
        </blockquote>
      )}

      {/* KPI band */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-rule border border-ink">
        <BigNumber
          emphasis
          label={`${winner?.name ?? "Lead"} · p50`}
          value={fmtUnit(winnerP50, benchmark.unit).replace(/\s.*/, "")}
          unit={benchmark.unit === "s" ? " s" : " ms"}
          caption="Cross-region median latency"
        />
        <BigNumber
          label="Field median"
          value={fmtUnit(fieldP50, benchmark.unit).replace(/\s.*/, "")}
          unit={benchmark.unit === "s" ? " s" : " ms"}
          caption={`Median across ${benchmark.results.length} providers`}
        />
        <BigNumber
          label="Tail spread (p99)"
          value={`${tailMultiple.toFixed(1)}×`}
          caption={`Worst p99 vs lead p99 — ${fmtUnit(worstP99, benchmark.unit)} vs ${fmtUnit(winnerP99, benchmark.unit)}`}
        />
      </div>

      <SectionRule label="Abstract" number="i" />
      <p className="font-serif text-[1.08rem] leading-[1.7] dropcap">
        {benchmark.abstract}
      </p>

      <SectionRule label="Distribution" number="ii" />
      <Figure
        number="1"
        title={`${benchmark.metric} (p50, p90, p99) by provider`}
        source={`OpenChainBench harness, ${benchmark.sampleSize.toLocaleString()} samples · ${formatLastRun(benchmark.lastRunAt)}`}
        note={
          <>
            Lower is better. Range is p50 → p99; dashed line is field median.
            Failed requests are excluded from latency aggregates and counted
            toward success rate (Table 1).
          </>
        }
      >
        <RangeChart results={benchmark.results} unit={benchmark.unit} />
      </Figure>

      <SectionRule label="Full ledger" number="iii" />
      <Figure
        number="2"
        title="Latency, reliability and 24-hour trend, by provider"
        source="OpenChainBench harness · cross-region medians"
        note={
          <>
            Sparklines plot p50 over the last 24 hours, on a shared Y-axis so
            magnitudes are comparable across providers. The lead row is shaded.
          </>
        }
      >
        <LedgerTable benchmark={benchmark} />
      </Figure>

      <SectionRule label="By region" number="iv" />
      <Figure
        number="3"
        title="p50 latency by region — small multiples"
        source="OpenChainBench harness · per-region cross-section"
        note={
          <>
            Each region is independently scaled to its own maximum so the
            ranking is read across, not across regions. Solid bars are the
            regional leader.
          </>
        }
      >
        <RegionGrid benchmark={benchmark} />
      </Figure>

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

      {/* Footer nav */}
      <nav className="mt-16 border-t-2 border-ink pt-6">
        <h3 className="font-sans text-[11px] uppercase tracking-[0.22em] text-ink-muted">
          More from this issue
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
    </article>
  );
}
