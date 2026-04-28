import type { Metadata } from "next";
import Link from "next/link";
import {
  formatLastRun,
  getBenchmarks,
  getBenchmarksByCategory,
  getLeader,
} from "@/data/benchmarks";
import { Sparkline } from "@/components/sparkline";
import { fmtUnit } from "@/lib/format";

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
    <div className="mx-auto max-w-5xl px-6 py-12">
      <header className="border-b-2 border-ink pb-6">
        <p className="font-sans text-[11px] uppercase tracking-[0.22em] text-ink-muted">
          Section · Index
        </p>
        <h1 className="mt-2 font-serif text-5xl font-bold">Benchmarks</h1>
        <p className="mt-3 font-serif italic text-lg text-ink-soft max-w-2xl">
          Every open benchmark, grouped by infrastructure category. Each one
          is a YAML spec plus a harness — both public, both reproducible.
        </p>
      </header>

      {grouped.length === 0 ? (
        <p className="mt-12 font-serif italic text-center text-ink-muted">
          No benchmarks yet.{" "}
          <Link className="lnk" href="/contribute">
            Submit the first one
          </Link>
          .
        </p>
      ) : (
        <div className="mt-10 space-y-14">
          {grouped.map(([category, list]) => (
            <section key={category}>
              <h2 className="font-sans text-[11px] uppercase tracking-[0.22em] text-accent">
                § {category}
              </h2>
              <ul className="mt-4 divide-y divide-rule border-y border-ink">
                {list.map((b) => {
                  const leader = getLeader(b);
                  const series = leader
                    ? b.extras.series24h[leader.slug]
                    : undefined;
                  return (
                    <li key={b.slug} className="py-6 grid gap-4 md:grid-cols-12">
                      <div className="md:col-span-2 font-sans text-[11px] uppercase tracking-[0.2em] text-ink-muted">
                        № {b.number}
                      </div>
                      <div className="md:col-span-6">
                        <Link
                          href={`/benchmarks/${b.slug}`}
                          className="font-serif text-2xl font-semibold leading-snug hover:text-accent"
                        >
                          {b.title}
                        </Link>
                        <p className="mt-1 font-serif italic text-ink-soft">
                          {b.subtitle}
                        </p>
                      </div>
                      <div className="md:col-span-4 flex items-center justify-end gap-4 font-mono text-xs tabular text-ink-soft">
                        {series && series.length > 0 && (
                          <Sparkline values={series} emphasis width={88} height={22} />
                        )}
                        <div className="text-right">
                          {leader ? (
                            <>
                              <p>Lead · {leader.name}</p>
                              <p className="mt-1 text-ink-faint">
                                {fmtUnit(leader.ms.p50, b.unit)} ·{" "}
                                {formatLastRun(b.lastRunAt)}
                              </p>
                            </>
                          ) : (
                            <p className="text-ink-muted italic">
                              Awaiting first run
                            </p>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <p className="mt-16 font-serif italic text-ink-muted text-sm text-center">
        {all.length} {all.length === 1 ? "benchmark" : "benchmarks"} published.{" "}
        <Link className="lnk" href="/contribute">
          Add yours
        </Link>{" "}
        — anyone can.
      </p>
    </div>
  );
}
