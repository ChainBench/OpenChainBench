import Link from "next/link";
import { getBenchmarks } from "@/data/benchmarks";
import { fmtValue, unitSuffix } from "@/lib/format";
import { leader } from "@/lib/ranking";
import { MiniChart } from "@/components/mini-chart";

const CATEGORY_COLOR: Record<string, string> = {
  Aggregators: "var(--color-accent, #c97c5d)",
  Data: "var(--color-good, #6a9466)",
  Bridges: "var(--color-warn, #c08a3c)",
  Wallets: "#7a6db8",
  RPCs: "#5da0a3",
};

export default async function HomePage() {
  const benchmarks = await getBenchmarks();

  return (
    <>
      {/* Hero — masthead carries the live-status ticker, so the hero
          stays editorial: dek + lead paragraph, nothing else. */}
      <section className="px-4 pt-16 sm:pt-20 pb-2">
        <div className="mx-auto max-w-6xl">
          <h1 className="display text-3xl sm:text-4xl md:text-5xl text-ink max-w-4xl">
            Open-source KPIs from onchain products.
          </h1>
          <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
            Benchmark & monitor key metrics from the best onchain products through transparent live-running ingests.
          </p>
        </div>
      </section>

      {/* Reports table */}
      <section id="latest" className="px-4 pt-12 pb-12 sm:pt-16 sm:pb-16 scroll-mt-16">
        <div className="mx-auto max-w-6xl">
          {/* Table head — same grid as rows so columns align cleanly. */}
          <div
            className="hidden sm:grid grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_6rem] items-end gap-4 sm:gap-6 border-b-2 border-ink pb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted"
            role="row"
          >
            <span className="pl-1">№</span>
            <span>Benchmark</span>
            <span>24 Hours</span>
            <span className="text-right">Value</span>
          </div>
          {/* Mobile head — single line */}
          <div className="sm:hidden flex items-end justify-between border-b-2 border-ink pb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            <span>Benchmark</span>
            <span>Value</span>
          </div>

          {benchmarks.length === 0 ? (
            <EmptyState />
          ) : (
            <ol className="divide-y divide-rule border-b border-rule">
              {benchmarks.map((b) => {
                const lead = leader(b);
                const isDraft = b.status === "draft";
                const catColor = CATEGORY_COLOR[b.category];
                return (
                  <li key={b.slug}>
                    <Link
                      href={`/benchmarks/${b.slug}`}
                      className="group relative grid grid-cols-[2.5rem_1fr] sm:grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_6rem] items-center gap-4 sm:gap-6 py-5 hover:bg-paper-soft/60 transition-colors before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-ink before:opacity-0 before:transition-opacity hover:before:opacity-100"
                    >
                      <span
                        className="font-mono text-[12px] font-medium tabular pl-1"
                        style={{ color: catColor ?? "var(--color-ink-soft)" }}
                      >
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

                      {/* Headline value — provider name + leader caption removed */}
                      <div className="hidden sm:flex justify-end items-baseline">
                        {lead && !isDraft ? (
                          <span className="font-mono tabular text-base sm:text-lg text-ink leading-none">
                            {fmtValue(lead.ms.p50, b.unit)}
                            <span className="text-ink-faint text-sm">{unitSuffix(b.unit)}</span>
                          </span>
                        ) : (
                          <span className="text-xs text-ink-faint">—</span>
                        )}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="mt-4 flex justify-end">
            <Link
              href="/benchmarks"
              className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted hover:text-ink"
            >
              See all benchmarks →
            </Link>
          </div>
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
