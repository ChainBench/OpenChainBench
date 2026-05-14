import Link from "next/link";
import { getBenchmarks } from "@/data/benchmarks";
import { BenchmarkTable } from "@/components/benchmark-table";
import { LiveDashboard } from "@/components/live-dashboard";

export const revalidate = 60;

export default async function HomePage() {
  const benchmarks = await getBenchmarks();

  return (
    <>
      {/* Hero — editorial dek + live dashboard fronts the page. The live
          stream replaces the previous /live page so the home is the one
          surface where everything begins. */}
      <section className="px-4 pt-16 sm:pt-20 pb-2">
        <div className="mx-auto max-w-6xl">
          <h1 className="display text-3xl sm:text-4xl md:text-5xl text-ink max-w-4xl">
            Open-source KPIs from onchain products.
          </h1>
          <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
            Live multichain swaps, global market stats, and reproducible benchmarks of the
            providers behind them. all in one place, refreshed continuously.
          </p>
        </div>
      </section>

      {/* Live dashboard — streaming volume chart + compact feed + stats band. */}
      <section className="px-4 pt-8 pb-12">
        <div className="mx-auto max-w-6xl">
          <LiveDashboard />
        </div>
      </section>

      {/* Reports table */}
      <section id="latest" className="px-4 pt-4 pb-12 sm:pt-8 sm:pb-16 scroll-mt-16 border-t border-rule">
        <div className="mx-auto max-w-6xl">
          <p className="mt-8 mb-6 font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted">
            Benchmarks
          </p>
          {benchmarks.length === 0 ? (
            <div className="mt-12 card p-10 text-center">
              <p className="text-lg text-ink-muted">No benchmark specs yet.</p>
              <p className="mt-2 text-sm text-ink-faint">
                Drop a YAML in <code className="font-mono">benchmarks/</code> to get started. see the{" "}
                <Link className="lnk" href="/contribute">tutorial</Link>.
              </p>
            </div>
          ) : (
            <BenchmarkTable benchmarks={benchmarks} />
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
