import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import {
  formatLastRun,
  getBenchmark,
  getBenchmarks,
  getBenchmarkSlugs,
  getLeader,
} from "@/data/benchmarks";
import { RangeChart } from "@/components/range-chart";
import { LedgerTable } from "@/components/ledger-table";
import { RegionGrid } from "@/components/region-grid";
import { Figure } from "@/components/figure";
import { BigNumber } from "@/components/big-number";
import { SectionRule } from "@/components/section-rule";
import { fmtUnit, unitSuffix } from "@/lib/format";
import { providerColor } from "@/lib/colors";

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
  const leaderColor = leader ? providerColor(leader.slug) : undefined;
  const otherBenchmarks = all.filter((b) => b.slug !== benchmark.slug);

  const fieldP50 = isDraft
    ? 0
    : benchmark.results.reduce((s, r) => s + r.ms.p50, 0) /
      benchmark.results.length;
  const advantage = leader ? ((fieldP50 - leader.ms.p50) / fieldP50) * 100 : 0;
  const worstP99 = isDraft
    ? 0
    : Math.max(...benchmark.results.map((r) => r.ms.p99));
  const tailMultiple = leader && worstP99 > 0 ? worstP99 / leader.ms.p99 : 0;

  return (
    <article className="px-4 pt-12 sm:pt-16">
      <div className="mx-auto max-w-4xl">
        <Link
          href="/benchmarks"
          className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          All benchmarks
        </Link>

        <div className="mt-7 flex items-center gap-3">
          <span className="font-mono text-xs uppercase tracking-[0.12em] text-ink-faint">
            № {benchmark.number} · {benchmark.category}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-rule px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-ink-muted">
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
        <p className="mt-5 text-lg sm:text-xl text-ink-soft leading-relaxed">
          {benchmark.subtitle}
        </p>

        {/* Meta strip */}
        <dl className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-px bg-rule rounded-xl overflow-hidden border border-rule">
          <Meta term="Last run" value={formatLastRun(benchmark.lastRunAt)} />
          <Meta term="Sample size" value={Math.round(benchmark.sampleSize).toLocaleString()} />
          <Meta term="Providers" value={String(benchmark.results.length)} />
          <Meta term="Lead" value={leader?.name ?? "—"} highlight color={leaderColor} />
        </dl>

        {isDraft ? (
          <DraftNotice source={benchmark.source} />
        ) : leader && (
          <>
            {/* Headline pull quote */}
            <p className="mt-12 display text-2xl sm:text-3xl leading-tight max-w-3xl">
              <span style={{ color: leaderColor }}>{leader.name}</span>{" "}
              <span className="text-ink-soft font-normal">leads at</span>{" "}
              <span className="font-mono tabular">
                {fmtUnit(leader.ms.p50, benchmark.unit)}
              </span>{" "}
              {advantage > 0 && (
                <span className="text-ink-muted font-normal text-lg">
                  — about {Math.round(advantage)}% under the field median.
                </span>
              )}
            </p>

            {/* KPI band */}
            <div className="card mt-8 grid grid-cols-1 sm:grid-cols-3 gap-px bg-rule overflow-hidden">
              <BigNumber
                emphasis
                color={leaderColor}
                label={`${leader.name} · p50`}
                value={fmtUnit(leader.ms.p50, benchmark.unit).replace(/\s+\S+$/, "")}
                unit={unitSuffix(benchmark.unit).trim()}
                caption={
                  benchmark.unit === "pct" || benchmark.unit === "bps"
                    ? "Cross-route median fee"
                    : "Cross-region median latency"
                }
              />
              <BigNumber
                label="Field median"
                value={fmtUnit(fieldP50, benchmark.unit).replace(/\s+\S+$/, "")}
                unit={unitSuffix(benchmark.unit).trim()}
                caption={`Median across ${benchmark.results.length} providers`}
              />
              <BigNumber
                label="Tail spread (p99)"
                value={tailMultiple > 0 ? `${tailMultiple.toFixed(1)}×` : "—"}
                caption={
                  tailMultiple > 0
                    ? `Worst p99 ${fmtUnit(worstP99, benchmark.unit)} vs lead ${fmtUnit(leader.ms.p99, benchmark.unit)}`
                    : "n/a"
                }
              />
            </div>
          </>
        )}

        <SectionRule label="Abstract" />
        <p className="text-base sm:text-lg leading-relaxed text-ink-soft">
          {benchmark.abstract}
        </p>

        {!isDraft && (
          <>
            <SectionRule label="Distribution" />
            <Figure
              number="1"
              title={`${benchmark.metric} distribution`}
              source={`Run ${formatLastRun(benchmark.lastRunAt)} · ${Math.round(benchmark.sampleSize).toLocaleString()} samples`}
              note={
                <>
                  Lower is better. Range is p50 → p99; pill is each provider&apos;s
                  signature color. Failed requests are excluded from latency
                  aggregates and counted toward success rate.
                </>
              }
            >
              <RangeChart results={benchmark.results} unit={benchmark.unit} />
            </Figure>

            <SectionRule label="Full ledger" />
            <Figure
              number="2"
              title="Latency, reliability and 24-hour trend"
              source="Cross-region medians, all providers"
            >
              <LedgerTable benchmark={benchmark} />
            </Figure>

            {Object.keys(benchmark.extras.regions).length > 0 && (
              <>
                <SectionRule label="By region" />
                <Figure
                  number="3"
                  title="p50 latency by region"
                  source="Per-region cross-section"
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
                  <span className="font-mono text-xs tabular text-ink-faint mt-1.5 w-6 shrink-0">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <p className="text-base leading-relaxed text-ink-soft">{f}</p>
                </li>
              ))}
            </ol>
          </>
        )}

        <SectionRule label="Methodology" />
        <ul className="space-y-3 text-[0.97rem] leading-relaxed text-ink-soft">
          {benchmark.methodology.map((m) => (
            <li key={m} className="flex gap-3">
              <span className="text-ink-faint mt-1.5">—</span>
              <span>{m}</span>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-sm text-ink-muted">
          Source code:{" "}
          <a
            className="inline-flex items-center gap-1 text-ink hover:underline"
            href={benchmark.source}
          >
            {benchmark.source.replace("https://github.com/", "")}
            <ArrowUpRight size={12} strokeWidth={2} />
          </a>
        </p>

        {!isDraft && (
          <>
            <SectionRule label="Cite this report" />
            <pre className="card font-mono text-[11px] leading-relaxed bg-bg-soft p-5 overflow-x-auto whitespace-pre-wrap">
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
      </div>

      {otherBenchmarks.length > 0 && (
        <div className="mx-auto max-w-6xl mt-24 px-0">
          <div className="border-t border-rule pt-12">
            <div className="mx-auto max-w-4xl">
              <span className="eyebrow">More benchmarks</span>
            </div>
            <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 items-stretch">
              {otherBenchmarks.map((b) => {
                const lead = getLeader(b);
                return (
                  <li key={b.slug} className="flex">
                    <Link
                      href={`/benchmarks/${b.slug}`}
                      className="flex-1 card-soft p-5 flex flex-col"
                    >
                      <p className="font-mono text-xs uppercase tracking-[0.12em] text-ink-faint">
                        № {b.number} · {b.category}
                      </p>
                      <p className="mt-3 display text-lg font-bold leading-tight">
                        {b.title}
                      </p>
                      <p className="mt-2 text-sm text-ink-muted line-clamp-2 flex-1">
                        {b.subtitle}
                      </p>
                      {lead && (
                        <p
                          className="mt-4 text-xs font-medium"
                          style={{ color: providerColor(lead.slug) }}
                        >
                          Lead · {lead.name}
                        </p>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </article>
  );
}

function Meta({
  term,
  value,
  highlight,
  color,
}: {
  term: string;
  value: string;
  highlight?: boolean;
  color?: string;
}) {
  return (
    <div className="bg-bg-elev px-4 py-3.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
        {term}
      </p>
      <p
        className={`mt-1 font-mono text-sm tabular ${highlight ? "font-semibold" : "text-ink-soft"}`}
        style={highlight && color ? { color } : undefined}
      >
        {value}
      </p>
    </div>
  );
}

function DraftNotice({ source }: { source: string }) {
  return (
    <div className="mt-12 card p-6 sm:p-8">
      <p className="eyebrow">Draft — Awaiting first run</p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft max-w-2xl">
        The spec for this benchmark is published but the harness has not
        emitted enough data yet. The methodology below describes what will
        be measured. The page will switch to live data on the next ISR
        revalidation once Prometheus has results.
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
