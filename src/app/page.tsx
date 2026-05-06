import Link from "next/link";
import { getBenchmarks } from "@/data/benchmarks";
import { BenchmarkTable } from "@/components/benchmark-table";

export default async function HomePage() {
  const benchmarks = await getBenchmarks();

  return (
    <>
      {/* Hero. masthead carries the live-status ticker, so the hero
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
