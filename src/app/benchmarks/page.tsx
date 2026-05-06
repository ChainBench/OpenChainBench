import type { Metadata } from "next";
import Link from "next/link";
import { getBenchmarks } from "@/data/benchmarks";
import { MiniChart } from "@/components/mini-chart";
import { fmtValue, unitSuffix } from "@/lib/format";
import { leader } from "@/lib/ranking";

export const metadata: Metadata = {
  title: "Benchmarks",
  description: "All open benchmarks for crypto infrastructure.",
};

const CATEGORY_COLOR: Record<string, string> = {
  Aggregators: "var(--color-accent, #c97c5d)",
  Data: "var(--color-good, #6a9466)",
  Bridges: "var(--color-warn, #c08a3c)",
  Wallets: "#7a6db8",
  RPCs: "#5da0a3",
};

export default async function BenchmarksIndex() {
  const all = await getBenchmarks();

  return (
    <div className="px-4 pt-12 pb-12 sm:pt-16 sm:pb-16">
      <div className="mx-auto max-w-6xl">
        <h1 className="display text-3xl sm:text-4xl tracking-tight">
          Index
        </h1>
        <p className="mt-3 max-w-2xl text-base text-ink-muted leading-snug">
          Every published benchmark. Click into a row for the full report — chart, ledger, methodology and the harness that produces the numbers.
        </p>

        {all.length === 0 ? (
          <p className="mt-16 text-center text-ink-muted">
            No benchmarks yet.{" "}
            <Link className="lnk" href="/contribute">
              Submit the first one
            </Link>
            .
          </p>
        ) : (
          <>
            {/* Table head — same grid as rows so columns align cleanly */}
            <div
              className="hidden sm:grid mt-10 grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_6rem] items-end gap-4 sm:gap-6 border-b-2 border-ink pb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted"
              role="row"
            >
              <span className="pl-1">№</span>
              <span>Benchmark</span>
              <span>24 Hours</span>
              <span className="text-right">Value</span>
            </div>
            <div className="sm:hidden mt-10 flex items-end justify-between border-b-2 border-ink pb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
              <span>Benchmark</span>
              <span>Value</span>
            </div>

            <ol className="divide-y divide-rule border-b border-rule">
              {all.map((b) => {
                const lead = leader(b);
                const isDraft = b.status === "draft";
                const catColor = CATEGORY_COLOR[b.category];
                return (
                  <li key={b.slug}>
                    <Link
                      href={`/benchmarks/${b.slug}`}
                      style={{ ["--cat-color" as string]: catColor ?? "var(--color-ink)" }}
                      className="group relative grid grid-cols-[2.5rem_1fr] sm:grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_6rem] items-center gap-4 sm:gap-6 py-5 hover:bg-paper-soft/60 transition-colors before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-[var(--cat-color)] before:opacity-0 before:transition-opacity hover:before:opacity-100"
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

                      <div className="hidden sm:block min-w-0">
                        {!isDraft && (
                          <MiniChart benchmark={b} height={32} legend className="opacity-90" />
                        )}
                      </div>

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
          </>
        )}
      </div>
    </div>
  );
}
