import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getBenchmarks } from "@/data/benchmarks";
import { HeroRadar } from "@/components/hero-radar";
import { HomeBenchTable } from "@/components/home-bench-table";
import { LiveDashboard } from "@/components/live-dashboard";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "OpenChainBench. Open benchmarks for crypto infrastructure",
  description:
    "State of the art across the most challenging benchmarks for crypto infrastructure, data providers, and bridge nodes.",
};

export default async function HomePage() {
  const benchmarks = await getBenchmarks();

  return (
    <article className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-20 space-y-20 sm:space-y-28">
      {/* Hero */}
      <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,520px)] gap-10 items-center">
        <div>
          <h1 className="display text-4xl sm:text-5xl md:text-6xl text-ink leading-[1.04]">
            Highest accuracy at every price point
          </h1>
          <p className="mt-6 max-w-xl text-base sm:text-lg text-ink-soft leading-snug">
            State of the art across the most challenging benchmarks for crypto
            infrastructure, data providers, and bridge nodes.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/benchmarks"
              className="inline-flex items-center gap-2 rounded-md bg-accent hover:bg-accent/90 text-white px-4 py-2.5 text-sm font-semibold tracking-wide uppercase transition-colors"
            >
              View all benchmarks
              <kbd className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] rounded text-[10px] font-mono bg-white/20 px-1">
                B
              </kbd>
            </Link>
            <Link
              href="/contribute"
              className="inline-flex items-center gap-2 rounded-md border border-rule-strong bg-surface hover:border-ink/40 text-ink px-4 py-2.5 text-sm font-semibold tracking-wide uppercase transition-colors"
            >
              Contribute
              <ArrowRight size={14} strokeWidth={2} />
            </Link>
          </div>
        </div>
        <div className="flex justify-center lg:justify-end">
          <HeroRadar size={520} />
        </div>
      </section>

      {/* Live Network ecosystem */}
      <section>
        <header className="mb-6 sm:mb-8">
          <h2 className="display text-3xl sm:text-4xl text-ink">Network Ecosystem</h2>
          <p className="mt-3 max-w-2xl text-sm sm:text-base text-ink-soft leading-snug">
            Live stream of ecosystem data, transaction volumes, and network activity across
            supported chains.
          </p>
        </header>
        <LiveDashboard />
      </section>

      {/* Latest deployed benchmarks */}
      <HomeBenchTable benchmarks={benchmarks} />
    </article>
  );
}
