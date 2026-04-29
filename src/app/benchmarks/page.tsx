import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  formatLastRun,
  getBenchmarks,
  getBenchmarksByCategory,
} from "@/data/benchmarks";
import { Sparkline } from "@/components/sparkline";

export const metadata: Metadata = {
  title: "Benchmarks — Index",
  description: "All open benchmarks for crypto infrastructure.",
};

export default async function BenchmarksIndex() {
  const [grouped, all] = await Promise.all([
    getBenchmarksByCategory(),
    getBenchmarks(),
  ]);

  return (
    <div className="px-4 pt-12 sm:pt-16">
      <div className="mx-auto max-w-5xl">
        <span className="eyebrow">Index</span>
        <h1 className="mt-5 display text-4xl sm:text-5xl">
          Reports, grouped by infrastructure.
        </h1>
        <p className="mt-4 max-w-2xl editorial text-lg text-ink-muted leading-snug">
          Every published benchmark. Each one is a YAML spec plus a harness — both public, both reproducible.
        </p>

        {grouped.length === 0 ? (
          <p className="mt-16 text-center text-ink-muted">
            No benchmarks yet.{" "}
            <Link className="lnk" href="/contribute">
              Submit the first one
            </Link>
            .
          </p>
        ) : (
          <div className="mt-14 space-y-14">
            {grouped.map(([category, list]) => (
              <section key={category}>
                <div className="flex items-end justify-between border-b border-rule pb-3">
                  <h2 className="text-[12px] font-medium uppercase tracking-[0.16em] text-ink">
                    {category}
                  </h2>
                  <span className="font-mono text-[11px] tabular text-ink-muted">
                    {list.length} {list.length === 1 ? "report" : "reports"}
                  </span>
                </div>
                <ul className="mt-1 divide-y divide-rule">
                  {list.map((b) => {
                    const fastest = [...b.results].sort(
                      (a, c) => a.ms.p50 - c.ms.p50
                    )[0];
                    const series = fastest
                      ? b.extras.series24h[fastest.slug]
                      : undefined;
                    return (
                      <li key={b.slug}>
                        <Link
                          href={`/benchmarks/${b.slug}`}
                          className="grid grid-cols-12 items-baseline gap-4 py-7 hover:bg-paper-soft -mx-3 px-3 rounded transition-colors"
                        >
                          <div className="col-span-12 sm:col-span-2 benchmark-mark">
                            № {b.number}
                          </div>
                          <div className="col-span-12 sm:col-span-7">
                            <h3 className="display text-xl font-bold leading-snug">
                              {b.title}
                            </h3>
                            <p className="mt-1 editorial text-base text-ink-muted line-clamp-2">
                              {b.subtitle}
                            </p>
                          </div>
                          <div className="col-span-12 sm:col-span-3 flex items-center gap-3 sm:justify-end">
                            {series && series.length > 0 && (
                              <Sparkline values={series} width={70} height={22} />
                            )}
                            <div className="text-right font-mono text-[11px] tabular text-ink-muted">
                              <p>
                                {b.results.length} provider
                                {b.results.length === 1 ? "" : "s"}
                              </p>
                              <p className="mt-0.5 text-ink-faint">
                                {Math.round(b.sampleSize).toLocaleString()} samples
                              </p>
                              <p className="mt-0.5 text-ink-faint">
                                {formatLastRun(b.lastRunAt)}
                              </p>
                            </div>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        <div className="mt-24 card p-8 text-center">
          <p className="editorial text-base text-ink-muted">
            {all.length} {all.length === 1 ? "report" : "reports"} published — and counting.
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
