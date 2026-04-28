import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { getBenchmarks, formatLastRun, getLeader } from "@/data/benchmarks";
import { Sparkline } from "@/components/sparkline";
import { fmtUnit } from "@/lib/format";
import { providerColor } from "@/lib/colors";

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
      <section className="px-4 pt-20 sm:pt-28">
        <div className="mx-auto max-w-6xl">
          <span className="eyebrow">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-good animate-pulse" />
            Live · {liveCount} of {benchmarks.length} benchmarks
          </span>
          <h1 className="mt-6 display text-5xl sm:text-7xl md:text-[5.5rem] text-ink max-w-4xl">
            Benchmark crypto infrastructure.
          </h1>
          <p className="mt-6 max-w-2xl text-lg sm:text-xl text-ink-soft leading-relaxed">
            Open, reproducible performance data for the multichain stack —
            aggregators, bridges, RPCs, price feeds. Measured the same way every
            time. Every spec and every harness is public.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/benchmarks"
              className="inline-flex items-center gap-2 rounded-lg bg-ink px-5 py-3 text-sm font-medium text-bg hover:bg-accent-soft transition-colors"
            >
              Read benchmarks
            </Link>
            <Link
              href="/contribute"
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-3 text-sm font-medium text-ink-soft hover:text-ink"
            >
              Submit your own
              <ArrowUpRight size={14} strokeWidth={2.2} />
            </Link>
          </div>

          {/* Stats strip */}
          <dl className="mt-14 grid grid-cols-2 sm:grid-cols-4 gap-px bg-rule rounded-xl overflow-hidden border border-rule">
            <Stat label="Benchmarks" value={String(benchmarks.length)} />
            <Stat label="Live" value={String(liveCount)} />
            <Stat label="Providers tracked" value={String(totalProviders)} />
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
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div className="max-w-2xl">
              <span className="eyebrow">Latest reports</span>
              <h2 className="mt-5 display text-3xl sm:text-4xl">
                Open data, freshly run.
              </h2>
              <p className="mt-4 text-base text-ink-muted leading-relaxed">
                Hover any card for the abstract and the field. Click to read
                the full report.
              </p>
            </div>
            <Link
              href="/benchmarks"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-ink hover:text-ink-soft"
            >
              Browse all
              <ArrowUpRight size={16} strokeWidth={2} />
            </Link>
          </div>

          {benchmarks.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {benchmarks.map((b) => {
                const leader = getLeader(b);
                const series = leader ? b.extras.series24h[leader.slug] : undefined;
                const leaderColor = leader ? providerColor(leader.slug) : undefined;
                return (
                  <li key={b.slug} className="flex">
                    <Link
                      href={`/benchmarks/${b.slug}`}
                      className="group card-soft p-6 flex flex-col flex-1 transition-all"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-mono uppercase tracking-[0.12em] text-ink-faint">
                          № {b.number} · {b.category}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1.5 text-ink-muted`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              b.status === "live"
                                ? "bg-good"
                                : "bg-ink-faint"
                            }`}
                          />
                          {b.status === "live" ? "Live" : "Draft"}
                        </span>
                      </div>

                      <h3 className="mt-5 display text-xl font-bold leading-tight">
                        {b.title}
                      </h3>
                      <p className="mt-2 text-sm text-ink-muted leading-relaxed line-clamp-3 flex-1">
                        {b.subtitle}
                      </p>

                      <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-rule pt-5">
                        <div>
                          <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
                            Lead
                          </dt>
                          <dd
                            className="mt-1 text-sm font-semibold"
                            style={leaderColor ? { color: leaderColor } : undefined}
                          >
                            {leader?.name ?? "—"}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
                            Best p50
                          </dt>
                          <dd className="mt-1 font-mono text-sm tabular text-ink">
                            {leader ? fmtUnit(leader.ms.p50, b.unit) : "—"}
                          </dd>
                        </div>
                      </dl>

                      {series && series.length > 0 && (
                        <div className="mt-5 flex items-center justify-between text-[11px] text-ink-faint">
                          <span className="font-mono tabular">
                            {b.status === "draft"
                              ? "Spec published"
                              : `Updated ${formatLastRun(b.lastRunAt)}`}
                          </span>
                          <Sparkline
                            values={series}
                            color={leaderColor}
                            width={70}
                            height={18}
                          />
                        </div>
                      )}

                      {/* Hover unfurl: abstract + the field */}
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
                                <ul className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-sm">
                                  {b.results.map((r) => (
                                    <li
                                      key={r.slug}
                                      className="font-medium"
                                      style={{ color: providerColor(r.slug) }}
                                    >
                                      {r.name}
                                    </li>
                                  ))}
                                </ul>
                              </div>
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
      <section className="px-4 py-24 sm:py-32 bg-bg-soft border-y border-rule">
        <div className="mx-auto max-w-6xl">
          <span className="eyebrow">How it works</span>
          <h2 className="mt-5 display text-3xl sm:text-4xl max-w-2xl">
            Spec it. Push metrics. The page renders itself.
          </h2>

          <div className="mt-12 grid gap-10 md:grid-cols-3">
            <Pillar
              n="01"
              title="One YAML per benchmark"
              body="Editorial metadata + Prometheus queries in a single file. Drop it in benchmarks/, open a PR. The format is a Zod schema; CI rejects malformed specs."
            />
            <Pillar
              n="02"
              title="Run a harness anywhere"
              body="Whatever language fits — Bun, Node, Python, Go. Push the metrics named in your YAML. The site re-queries every minute via ISR."
            />
            <Pillar
              n="03"
              title="Live leader, no gatekeeping"
              body="The leader on every page is computed at render time from the data. No spec marks a winner ahead of time. Pull requests for new providers welcome."
            />
          </div>

          <div className="mt-12 flex flex-wrap items-center gap-3">
            <Link
              href="/contribute"
              className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-bg hover:bg-accent-soft"
            >
              Read the tutorial
            </Link>
            <a
              href="https://github.com/OpenChainBench/OpenChainBench"
              className="inline-flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium text-ink-soft hover:text-ink"
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
    <div className="bg-bg-elev px-5 py-4">
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
      <p className="font-mono text-xs tabular text-ink-faint">{n}</p>
      <h3 className="mt-2 display text-xl">{title}</h3>
      <p className="mt-3 text-sm text-ink-muted leading-relaxed">{body}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-12 card p-10 text-center">
      <p className="text-base text-ink-muted">No benchmark specs yet.</p>
      <p className="mt-2 text-sm text-ink-faint">
        Drop a YAML in <code className="font-mono">benchmarks/</code> to get
        started — see the{" "}
        <Link className="lnk" href="/contribute">
          tutorial
        </Link>
        .
      </p>
    </div>
  );
}
