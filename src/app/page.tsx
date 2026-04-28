import Link from "next/link";
import { getBenchmarks, formatLastRun } from "@/data/benchmarks";
import { Sparkline } from "@/components/sparkline";
import { fmtUnit } from "@/lib/format";

export default async function HomePage() {
  const benchmarks = await getBenchmarks();
  const liveCount = benchmarks.filter((b) => b.status === "live").length;
  const totalSamples = benchmarks.reduce((s, b) => s + b.sampleSize, 0);
  const totalProviders = new Set(
    benchmarks.flatMap((b) => b.results.map((r) => r.slug))
  ).size;

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      {/* Front-page hero */}
      <section className="grid gap-8 md:grid-cols-12">
        <div className="md:col-span-8">
          <p className="font-sans text-[11px] uppercase tracking-[0.22em] text-accent">
            The journal
          </p>
          <h2 className="mt-3 font-serif text-4xl sm:text-5xl md:text-6xl font-bold leading-[1.02] tracking-tight">
            Open benchmarks for crypto infrastructure.
          </h2>
          <p className="mt-4 font-serif italic text-xl text-ink-soft max-w-2xl">
            Latency, accuracy, reliability and cost across the multichain
            stack — measured the same way every time, with the scripts that
            produced the numbers published alongside.
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 font-sans text-sm">
            <Link
              href="/benchmarks"
              className="inline-flex items-center gap-2 border-b-2 border-ink pb-0.5 hover:text-accent"
            >
              Read benchmarks &rarr;
            </Link>
            <Link href="/contribute" className="lnk text-ink-soft hover:text-ink">
              Submit your own
            </Link>
            <a
              className="lnk text-ink-soft hover:text-ink"
              href="https://github.com/OpenChainBench/OpenChainBench"
            >
              GitHub ↗
            </a>
          </div>
        </div>

        {/* Sidebar — newspaper "today" facts */}
        <aside className="md:col-span-4 md:border-l md:border-rule md:pl-8">
          <h3 className="font-sans text-[11px] uppercase tracking-[0.22em] text-ink-muted">
            Today
          </h3>
          <dl className="mt-4 grid grid-cols-1 divide-y divide-rule border-y border-ink/80">
            <Fact label="Reports" value={String(benchmarks.length)} />
            <Fact label="Live now" value={`${liveCount} of ${benchmarks.length}`} />
            <Fact label="Providers tracked" value={String(totalProviders)} />
            <Fact
              label="Samples · 24h"
              value={Math.round(totalSamples).toLocaleString()}
            />
          </dl>
          <p className="mt-6 font-serif italic text-sm text-ink-soft">
            Numbers are pulled live from open Prometheus instances every
            minute. No editorial winner is set ahead of time.
          </p>
        </aside>
      </section>

      <div className="my-12 rule-double" />

      {/* Reports grid */}
      <section id="latest" className="">
        <div className="flex items-end justify-between border-b-2 border-ink pb-3">
          <h3 className="font-serif text-3xl font-bold">Reports</h3>
          <Link
            href="/benchmarks"
            className="font-sans text-[11px] uppercase tracking-[0.22em] text-ink-soft lnk"
          >
            Full index &rarr;
          </Link>
        </div>

        {benchmarks.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="mt-6 grid gap-px bg-rule border border-rule sm:grid-cols-2 lg:grid-cols-3">
            {benchmarks.map((b) => {
              const fastest = [...b.results].sort(
                (a, c) => a.ms.p50 - c.ms.p50
              )[0];
              const series = fastest
                ? b.extras.series24h[fastest.slug]
                : undefined;
              return (
                <li key={b.slug} className="contents">
                  <Link
                    href={`/benchmarks/${b.slug}`}
                    className="group bg-paper p-5 flex flex-col transition-[background] duration-150 hover:bg-paper-deep/40"
                  >
                    <div className="flex items-baseline justify-between font-sans text-[10px] uppercase tracking-[0.18em] text-ink-muted">
                      <span>№&nbsp;{b.number}</span>
                      <span>{b.category}</span>
                    </div>
                    <p className="mt-2 font-serif text-xl font-semibold leading-tight text-ink group-hover:text-accent transition-colors">
                      {b.title}
                    </p>
                    <p className="mt-2 font-serif italic text-sm text-ink-soft line-clamp-3 flex-1">
                      {b.subtitle}
                    </p>
                    <div className="mt-4 flex items-center justify-between gap-3 border-t border-rule pt-3">
                      <span className="font-mono text-[10px] tabular text-ink-muted">
                        {b.results.length} provider
                        {b.results.length === 1 ? "" : "s"} ·{" "}
                        {Math.round(b.sampleSize).toLocaleString()} samples
                      </span>
                      {series && series.length > 0 && (
                        <Sparkline values={series} width={70} height={18} />
                      )}
                    </div>
                    <p className="mt-2 font-mono text-[10px] tabular text-ink-faint">
                      {b.status === "draft"
                        ? "Draft · spec published"
                        : `Updated ${formatLastRun(b.lastRunAt)}`}
                    </p>

                    {/* Hover unfurl: abstract + the field — entirely neutral */}
                    <div className="grid grid-rows-[0fr] group-hover:grid-rows-[1fr] transition-[grid-template-rows] duration-300 ease-out">
                      <div className="overflow-hidden">
                        <div className="mt-4 pt-4 border-t border-ink/40 space-y-3">
                          <div>
                            <p className="font-sans text-[10px] uppercase tracking-[0.2em] text-ink-muted">
                              From the abstract
                            </p>
                            <p className="mt-1.5 font-serif text-sm leading-relaxed text-ink-soft line-clamp-4">
                              {b.abstract}
                            </p>
                          </div>
                          {b.results.length > 0 && (
                            <div>
                              <p className="font-sans text-[10px] uppercase tracking-[0.2em] text-ink-muted">
                                The field
                              </p>
                              <p className="mt-1.5 font-serif text-sm text-ink-soft">
                                {b.results.map((r) => r.name).join(" · ")}
                              </p>
                            </div>
                          )}
                          {fastest && (
                            <p className="font-mono text-[10px] tabular text-ink-muted">
                              fastest p50 · {fmtUnit(fastest.ms.p50, b.unit)}{" "}
                              · slowest p99 ·{" "}
                              {fmtUnit(
                                Math.max(...b.results.map((r) => r.ms.p99)),
                                b.unit
                              )}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Editorial pillars */}
      <section className="mt-16 border-y-2 border-ink py-10">
        <div className="grid gap-8 md:grid-cols-3">
          <Pillar
            n="I"
            title="Open methodology"
            body="Every benchmark ships with the script that produced it. Re-run it on your own infra; if our numbers don't match yours, we want to know."
          />
          <Pillar
            n="II"
            title="Reproducible runs"
            body="Inputs, regions, cadence and timeouts are pinned. Raw transcripts are stored so any single data point can be audited after the fact."
          />
          <Pillar
            n="III"
            title="Neutral presentation"
            body="No spec marks a winner ahead of time. The site renders every provider with equal weight and lets readers do their own ranking from the data."
          />
        </div>
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-3">
      <dt className="font-sans text-[10px] uppercase tracking-[0.18em] text-ink-muted">
        {label}
      </dt>
      <dd className="mt-1 font-serif text-xl font-semibold tabular">{value}</dd>
    </div>
  );
}

function Pillar({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div>
      <p className="font-serif text-3xl text-ink-muted">{n}.</p>
      <h4 className="mt-1 font-serif text-xl font-semibold">{title}</h4>
      <p className="mt-2 font-serif text-[1rem] leading-relaxed text-ink-soft">
        {body}
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-8 border border-rule bg-paper-deep/50 p-8 text-center">
      <p className="font-serif italic text-lg text-ink-soft">
        No benchmark specs found yet.
      </p>
      <p className="mt-2 font-serif text-sm text-ink-muted">
        Drop a YAML in <code className="font-mono">benchmarks/</code> and open
        a PR. The{" "}
        <Link className="lnk" href="/contribute">
          tutorial
        </Link>{" "}
        walks through the four steps.
      </p>
    </div>
  );
}
