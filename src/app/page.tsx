import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
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
    <>
      {/* Hero */}
      <section className="px-4 pt-16 sm:pt-24">
        <div className="mx-auto max-w-6xl">
          <span className="eyebrow">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-good animate-pulse" />
            Live · {liveCount} of {benchmarks.length} benchmarks
          </span>
          <h1 className="mt-6 display text-5xl sm:text-7xl md:text-[5.25rem] text-ink max-w-4xl">
            Benchmark crypto infrastructure.
          </h1>
          <p className="mt-5 max-w-2xl text-xl sm:text-2xl text-ink-soft leading-snug">
            Real-time latency, cost and reliability data for the multichain stack — aggregators, bridges, RPCs, price feeds. Same metric, same conditions, every provider.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/benchmarks" className="btn-primary">
              Read benchmarks
            </Link>
            <Link href="/contribute" className="btn-ghost">
              Submit your own
              <ArrowUpRight size={14} strokeWidth={2.2} />
            </Link>
          </div>

          {/* Stats strip — neutral facts */}
          <dl className="mt-14 grid grid-cols-2 sm:grid-cols-4 gap-px bg-rule rounded overflow-hidden border border-rule">
            <Stat label="Reports" value={String(benchmarks.length)} />
            <Stat label="Live" value={`${liveCount} / ${benchmarks.length}`} />
            <Stat label="Providers" value={String(totalProviders)} />
            <Stat
              label="Samples · 24h"
              value={Math.round(totalSamples).toLocaleString()}
            />
          </dl>
        </div>
      </section>

      {/* Reports grid */}
      <section className="px-4 py-24 sm:py-32">
        <div className="mx-auto max-w-6xl">
          <div className="flex items-end justify-between gap-6 flex-wrap border-b border-rule pb-3">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
              Live benchmarks
            </h2>
            <Link
              href="/benchmarks"
              className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted lnk hover:text-ink"
            >
              View all ↗
            </Link>
          </div>

          {benchmarks.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {benchmarks.map((b) => {
                const fastest = [...b.results].sort(
                  (a, c) => a.ms.p50 - c.ms.p50
                )[0];
                const series = fastest
                  ? b.extras.series24h[fastest.slug]
                  : undefined;
                return (
                  <li key={b.slug} className="flex">
                    <Link
                      href={`/benchmarks/${b.slug}`}
                      className="group card-soft p-6 flex flex-col flex-1"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="benchmark-mark">
                          № {b.number} · {b.category}
                        </span>
                        <span className="inline-flex items-center gap-1.5 text-ink-muted text-[10px] uppercase tracking-[0.14em]">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              b.status === "live" ? "bg-good" : "bg-ink-faint"
                            }`}
                          />
                          {b.status === "live" ? "Live" : "Draft"}
                        </span>
                      </div>

                      <h3 className="mt-5 display text-xl font-bold leading-tight text-ink">
                        {b.title}
                      </h3>
                      <p className="mt-3 editorial text-base text-ink-muted leading-snug line-clamp-3 flex-1">
                        {b.subtitle}
                      </p>

                      <div className="mt-6 grid grid-cols-2 gap-4 border-t border-rule pt-4">
                        <div>
                          <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
                            Providers
                          </dt>
                          <dd className="mt-1 text-sm text-ink">
                            {b.results.length}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
                            Samples · 24h
                          </dt>
                          <dd className="mt-1 font-mono text-sm tabular text-ink">
                            {Math.round(b.sampleSize).toLocaleString()}
                          </dd>
                        </div>
                      </div>

                      {series && series.length > 0 && (
                        <div className="mt-4 flex items-center justify-between text-[11px] text-ink-faint">
                          <span className="font-mono tabular">
                            {b.status === "draft"
                              ? "Spec published"
                              : `Updated ${formatLastRun(b.lastRunAt)}`}
                          </span>
                          <Sparkline values={series} width={70} height={18} />
                        </div>
                      )}

                      {/* Hover unfurl: abstract + the field — neutral */}
                      <div className="grid grid-rows-[0fr] group-hover:grid-rows-[1fr] transition-[grid-template-rows] duration-300 ease-out">
                        <div className="overflow-hidden">
                          <div className="mt-5 pt-5 border-t border-rule space-y-4">
                            <div>
                              <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint">
                                From the abstract
                              </p>
                              <p className="mt-2 text-sm leading-relaxed text-ink-soft line-clamp-4">
                                {b.abstract}
                              </p>
                            </div>
                            {b.results.length > 0 && (
                              <div>
                                <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint">
                                  The field
                                </p>
                                <p className="mt-2 editorial text-sm text-ink-soft">
                                  {b.results.map((r) => r.name).join(" · ")}
                                </p>
                              </div>
                            )}
                            {fastest && (
                              <p className="font-mono text-[10px] tabular text-ink-faint">
                                fastest p50 · {fmtUnit(fastest.ms.p50, b.unit)} ·{" "}
                                slowest p99 ·{" "}
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
        </div>
      </section>

      {/* Three-pillar editorial band */}
      <section className="px-4 py-24 sm:py-32 bg-paper-soft border-y border-rule">
        <div className="mx-auto max-w-6xl">
          <span className="eyebrow">How it works</span>
          <h2 className="mt-5 display text-3xl sm:text-4xl max-w-2xl">
            Spec it. Push metrics. The page renders itself.
          </h2>

          <div className="mt-12 grid gap-10 md:grid-cols-3">
            <Pillar
              n="01"
              title="One YAML per benchmark"
              body="Editorial metadata + Prometheus queries in a single file. Drop it in benchmarks/, open a PR. CI rejects malformed specs."
            />
            <Pillar
              n="02"
              title="Run a harness anywhere"
              body="Whatever language fits — Bun, Node, Python, Go. Push metrics named in your YAML. The site re-queries every minute."
            />
            <Pillar
              n="03"
              title="Neutral presentation"
              body="No spec marks a winner. Every provider is rendered with equal visual weight. Tables sort mechanically; readers compare the columns themselves."
            />
          </div>

          <div className="mt-12 flex flex-wrap items-center gap-3">
            <Link href="/contribute" className="btn-primary">
              Read the tutorial
            </Link>
            <a
              href="https://github.com/OpenChainBench/OpenChainBench"
              className="btn-ghost"
            >
              GitHub
              <ArrowUpRight size={14} strokeWidth={2.2} />
            </a>
          </div>
        </div>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-5 py-4">
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </p>
      <p className="mt-1 display text-2xl tabular">{value}</p>
    </div>
  );
}

function Pillar({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div>
      <p className="benchmark-mark">{n}</p>
      <h3 className="mt-2 display text-xl">{title}</h3>
      <p className="mt-3 text-sm text-ink-muted leading-relaxed">{body}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-12 card p-10 text-center">
      <p className="editorial text-lg text-ink-muted">No benchmark specs yet.</p>
      <p className="mt-2 text-sm text-ink-faint">
        Drop a YAML in <code className="font-mono">benchmarks/</code> to get started — see the{" "}
        <Link className="lnk" href="/contribute">tutorial</Link>.
      </p>
    </div>
  );
}
