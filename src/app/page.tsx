import Link from "next/link";
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

          {/* Editor's pick — replaces the generic CTA pair with one
              specific, dated finding. Update the blurb when the lead
              story changes (rotate every week or so). */}
          <Link
            href="/benchmarks/network-coverage"
            className="group mt-10 max-w-3xl flex items-baseline gap-4 border-y border-rule py-4 hover:bg-paper-soft/60 transition-colors"
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent shrink-0 pt-0.5">
              This&nbsp;week
            </span>
            <span className="text-sm sm:text-base text-ink-soft leading-snug">
              <span className="text-ink">Network-coverage spread is 3.4×</span> —
              GeckoTerminal lists 263 chains, Codex 133, Mobula 78. Coverage
              breadth is one axis of a data provider; latency and metadata are
              measured separately.
              <span className="ml-1 font-mono text-ink-muted group-hover:text-ink">→</span>
            </span>
          </Link>

          {/* Tiny prose ticker */}
          <p className="mt-10 max-w-2xl text-xs font-mono tabular text-ink-faint">
            {benchmarks.length} reports
            <span className="mx-1.5 text-ink-faint/40">·</span>
            {totalProviders} providers
            <span className="mx-1.5 text-ink-faint/40">·</span>
            {Math.round(totalSamples).toLocaleString()} samples in the past 24h
          </p>
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

      {/* Colophon — single-line editorial sign-off, replaces the
          three-pillar 'how it works' band. Detail lives on /contribute
          and /methodology; the home shouldn't oversell. */}
      <section className="px-4 py-16 border-t border-rule">
        <div className="mx-auto max-w-6xl">
          <p className="max-w-3xl text-sm text-ink-muted leading-relaxed">
            Every benchmark is a YAML spec plus a public harness exposing
            <span className="font-mono text-[0.92em] text-ink"> /metrics</span>.
            The site queries one shared Prometheus and re-renders every minute.
            Anyone can submit a benchmark — the{" "}
            <Link href="/contribute" className="text-ink hover:text-accent underline-offset-4 hover:underline">
              contribution guide
            </Link>{" "}
            walks through it.
          </p>
        </div>
      </section>
    </>
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
