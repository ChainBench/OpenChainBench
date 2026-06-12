import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getBenchmarks } from "@/data/benchmarks";
import { HeroRadar } from "@/components/hero-radar";
import { HomeBenchTable } from "@/components/home-bench-table";
import { LiveDashboard } from "@/components/live/dashboard";

export const revalidate = 60;

const DESCRIPTION =
  "Live benchmarks for crypto infrastructure: RPC latency, bridge fees, L2 finality and price feed accuracy. Open methodology, updated continuously.";

export const metadata: Metadata = {
  title: "OpenChainBench. Open benchmarks for crypto infrastructure",
  description: DESCRIPTION,
  alternates: { canonical: "https://openchainbench.com/" },
  openGraph: {
    title: "OpenChainBench. Open benchmarks for crypto infrastructure",
    description: DESCRIPTION,
    url: "https://openchainbench.com/",
    type: "website",
    siteName: "OpenChainBench",
  },
  twitter: {
    card: "summary_large_image",
    title: "OpenChainBench. Open benchmarks for crypto infrastructure",
    description: DESCRIPTION,
    site: "@OpenChainBench",
  },
};

export default async function HomePage() {
  const benchmarks = await getBenchmarks();

  return (
    <article className="mx-auto max-w-[1400px] px-4 sm:px-6 py-10 sm:py-14 space-y-14 sm:space-y-20">
      {/* Hero */}
      <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-8 lg:gap-12 items-center lg:pr-12">
        <div>
          <h1 className="display text-3xl sm:text-4xl md:text-5xl text-ink leading-[1.05]">
            Open benchmarks for RPC latency, bridge fees and L2 finality.
          </h1>
          <p className="mt-5 max-w-xl text-base text-ink-soft leading-snug">
            OpenChainBench runs continuous, reproducible benchmarks on crypto
            infrastructure: RPC providers, bridges, price feeds and data APIs.
            Open methodology, open harnesses, live data.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
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
        <div className="flex justify-center">
          <HeroRadar size={360} />
        </div>
      </section>

      {/* Live Network ecosystem */}
      <section>
        <header className="mb-5 sm:mb-7">
          <h2 className="display text-2xl sm:text-3xl text-ink">Network Ecosystem</h2>
          <p className="mt-2 max-w-2xl text-sm text-ink-soft leading-snug">
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
