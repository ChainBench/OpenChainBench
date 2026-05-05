import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { getBenchmarks, formatLastRun } from "@/data/benchmarks";
import { fmtValue, unitSuffix } from "@/lib/format";
import { leader } from "@/lib/ranking";
import { MiniChart } from "@/components/mini-chart";
import { LiveTimestamp } from "@/components/live-timestamp";
import { RefreshPulse } from "@/components/refresh-pulse";

const CATEGORY_COLOR: Record<string, string> = {
  Aggregators: "var(--color-accent, #c97c5d)",
  Data: "var(--color-good, #6a9466)",
  Bridges: "var(--color-warn, #c08a3c)",
  Wallets: "#7a6db8",
  RPCs: "#5da0a3",
};

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
          <h1 className="mt-6 display text-3xl sm:text-4xl md:text-5xl text-ink max-w-4xl">
            Benchmark crypto infrastructure.
          </h1>
          <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
            Real-time latency, cost and reliability data for the multichain stack. Aggregators, bridges, RPCs, price feeds. Same metric, same conditions, every provider.
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

          {/* Stats strip. neutral facts */}
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
      <section className="px-4 pt-12 pb-24 sm:pt-16 sm:pb-32">
        <div className="mx-auto max-w-6xl">
          <div className="flex items-end justify-between gap-6 flex-wrap border-b border-rule pb-3">
            <div className="flex items-baseline gap-3">
              <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
                Latest
              </h2>
              <RefreshPulse />
            </div>
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
            <ol className="mt-2 divide-y divide-rule border-b border-rule">
              {benchmarks.map((b) => {
                const lead = leader(b);
                const isDraft = b.status === "draft";
                const catColor = CATEGORY_COLOR[b.category];
                return (
                  <li key={b.slug}>
                    <Link
                      href={`/benchmarks/${b.slug}`}
                      className="group relative grid grid-cols-[2.5rem_1fr] sm:grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_10rem_5.5rem] items-center gap-4 sm:gap-6 py-5 hover:bg-paper-soft/60 transition-colors before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-ink before:opacity-0 before:transition-opacity hover:before:opacity-100"
                    >
                      <span className="font-mono text-[11px] tabular text-ink-faint pl-1">
                        № {b.number}
                      </span>

                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span
                            className="font-mono text-[10px] uppercase tracking-[0.18em] shrink-0"
                            style={{ color: catColor ?? "var(--color-ink-faint)" }}
                          >
                            {b.category}
                          </span>
                          {isDraft && (
                            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                              draft
                            </span>
                          )}
                        </div>
                        <h3 className="mt-1 display text-base sm:text-lg font-semibold text-ink leading-tight truncate">
                          {b.title}
                        </h3>
                        <p className="mt-0.5 text-xs text-ink-muted truncate">{b.subtitle}</p>
                      </div>

                      {/* Sparkline + multi-provider legend */}
                      <div className="hidden sm:block min-w-0">
                        {!isDraft && (
                          <MiniChart benchmark={b} height={32} legend className="opacity-90" />
                        )}
                      </div>

                      {/* Leader summary */}
                      <div className="hidden sm:flex flex-col items-end text-right min-w-0">
                        {lead && !isDraft ? (
                          <>
                            <span className="font-mono tabular text-base sm:text-lg text-ink leading-none">
                              {fmtValue(lead.ms.p50, b.unit)}
                              <span className="text-ink-faint text-sm">{unitSuffix(b.unit)}</span>
                            </span>
                            <span className="mt-1 text-[11px] text-ink-muted truncate max-w-full">
                              {lead.name} · leader
                            </span>
                          </>
                        ) : (
                          <span className="text-xs text-ink-faint">—</span>
                        )}
                      </div>

                      <span className="font-mono tabular text-[11px] text-ink-muted text-right whitespace-nowrap">
                        {isDraft ? (
                          "—"
                        ) : (
                          <LiveTimestamp at={b.lastRunAt} fallback={formatLastRun(b.lastRunAt)} />
                        )}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </section>

      {/* Three-pillar band */}
      <section className="px-4 py-24 sm:py-32 bg-paper-soft border-y border-rule">
        <div className="mx-auto max-w-6xl">
          <span className="eyebrow">How it works</span>
          <h2 className="mt-5 display text-3xl sm:text-4xl max-w-2xl">
            Spec the metric. Expose <span className="font-mono text-[0.85em]">/metrics</span>. The page renders itself.
          </h2>

          <div className="mt-12 grid gap-10 md:grid-cols-3">
            <Pillar
              n="01"
              title="One YAML per benchmark"
              body="Metadata + Prometheus queries in a single file. Drop it in benchmarks/, open a PR. CI rejects malformed specs."
            />
            <Pillar
              n="02"
              title="A harness in any language"
              body="Bun, Node, Python, Go, Rust. whatever fits the providers. The harness exposes /metrics; the shared OpenChainBench Prometheus scrapes it."
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
      <p className="font-mono text-[11px] tabular uppercase tracking-[0.18em] text-ink-faint">
        {n}
      </p>
      <h3 className="mt-2 display text-xl">{title}</h3>
      <p className="mt-3 text-sm text-ink-muted leading-relaxed">{body}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-12 card p-10 text-center">
      <p className="text-lg text-ink-muted">No benchmark specs yet.</p>
      <p className="mt-2 text-sm text-ink-faint">
        Drop a YAML in <code className="font-mono">benchmarks/</code> to get started. see the{" "}
        <Link className="lnk" href="/contribute">tutorial</Link>.
      </p>
    </div>
  );
}
