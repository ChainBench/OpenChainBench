import type { Metadata } from "next";
import { getBenchmarks } from "@/data/benchmarks";
import { BenchmarkGrid } from "@/components/benchmark-grid";

export const revalidate = 60;

const DESCRIPTION =
  "Comprehensive registry of open, reproducible benchmarks running across major protocols, bridges and indexers.";

export const metadata: Metadata = {
  title: "All benchmarks",
  description: DESCRIPTION,
};

export default async function BenchmarksPage() {
  const benchmarks = await getBenchmarks();

  return (
    <article className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16">
      <header className="mb-10">
        <h1 className="display text-4xl sm:text-5xl text-ink">All benchmarks</h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          {DESCRIPTION}
        </p>
      </header>
      <BenchmarkGrid benchmarks={benchmarks} />
    </article>
  );
}
