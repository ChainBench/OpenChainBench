import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  formatLastRun,
  getBenchmarks,
} from "@/data/benchmarks";
import { MiniChart } from "@/components/mini-chart";
import { Pill } from "@/components/pill";
import { fmtValue, unitSuffix } from "@/lib/format";

export const metadata: Metadata = {
  title: "Benchmarks",
  description: "All open benchmarks for crypto infrastructure.",
};

export default async function BenchmarksIndex() {
  const all = await getBenchmarks();

  return (
    <div className="px-4 pt-12 sm:pt-16">
      <div className="mx-auto max-w-6xl">
        <Pill variant="live" pulse>
          {all.filter((b) => b.status === "live").length} live
        </Pill>
        <h1 className="mt-5 display text-4xl sm:text-5xl">
          Benchmarks
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-ink-muted leading-snug">
          Every published benchmark. Click in to see the chart, the ledger, and the harness.
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
          <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {all.map((b) => {
              const fastest = [...b.results].sort(
                (a, c) => a.ms.p50 - c.ms.p50
              )[0];
              return (
                <li key={b.slug} className="flex">
                  <Link
                    href={`/benchmarks/${b.slug}`}
                    className="flex-1 card-soft p-6 flex flex-col"
                  >
                    <div className="flex items-center gap-2">
                      <Pill variant={b.status === "live" ? "live" : "draft"} pulse>
                        {b.status === "live" ? "Live" : "Draft"}
                      </Pill>
                      <Pill variant="category">{b.category}</Pill>
                    </div>

                    <h3 className="mt-5 display text-xl font-bold leading-tight">
                      {b.title}
                    </h3>

                    {fastest && (
                      <div className="mt-5">
                        <div className="flex items-end justify-between gap-3">
                          <div>
                            <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
                              Field min · p50
                            </p>
                            <p className="mt-1 display text-3xl tabular leading-none">
                              {fmtValue(fastest.ms.p50, b.unit)}
                              <span className="ml-1 text-base text-ink-muted font-normal">
                                {unitSuffix(b.unit).trim()}
                              </span>
                            </p>
                          </div>
                          <p className="text-[10px] font-mono tabular text-ink-faint uppercase tracking-[0.14em]">
                            24h
                          </p>
                        </div>
                        <div className="mt-3">
                          <MiniChart benchmark={b} height={64} legend />
                        </div>
                      </div>
                    )}

                    <div className="mt-5 pt-4 border-t border-rule grid grid-cols-3 gap-3 text-[11px]">
                      <div>
                        <p className="text-ink-faint uppercase tracking-[0.12em] font-medium">
                          Providers
                        </p>
                        <p className="mt-0.5 font-mono tabular text-ink">
                          {b.results.length}
                        </p>
                      </div>
                      <div>
                        <p className="text-ink-faint uppercase tracking-[0.12em] font-medium">
                          n · 24h
                        </p>
                        <p className="mt-0.5 font-mono tabular text-ink">
                          {Math.round(b.sampleSize).toLocaleString()}
                        </p>
                      </div>
                      <div>
                        <p className="text-ink-faint uppercase tracking-[0.12em] font-medium">
                          Updated
                        </p>
                        <p className="mt-0.5 font-mono tabular text-ink-muted">
                          {b.status === "draft" ? "—" : formatLastRun(b.lastRunAt)}
                        </p>
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-20 card p-8 text-center">
          <p className="text-base text-ink-muted">
            {all.length} {all.length === 1 ? "benchmark" : "benchmarks"} live. and counting.
          </p>
          <Link
            href="/contribute"
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink hover:text-ink-soft"
          >
            Submit your own
            <ArrowUpRight size={14} strokeWidth={2} />
          </Link>
        </div>
      </div>
    </div>
  );
}
