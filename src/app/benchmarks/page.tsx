import type { Metadata } from "next";
import { getBenchmarks } from "@/data/benchmarks";
import { BenchmarkGrid } from "@/components/benchmark-grid";
import { safeJsonLd, buildItemListJsonLd } from "@/lib/jsonld";

export const revalidate = 60;

const DESCRIPTION =
  "Comprehensive registry of open, reproducible benchmarks running across major protocols, bridges and indexers.";

export const metadata: Metadata = {
  title: "All benchmarks",
  description: DESCRIPTION,
  alternates: { canonical: "https://openchainbench.com/benchmarks" },
  openGraph: {
    title: "All benchmarks · OpenChainBench",
    description: DESCRIPTION,
    url: "https://openchainbench.com/benchmarks",
    type: "website",
    siteName: "OpenChainBench",
  },
  twitter: {
    card: "summary_large_image",
    title: "All benchmarks · OpenChainBench",
    description: DESCRIPTION,
    site: "@OpenChainBench",
  },
};

export default async function BenchmarksPage() {
  const benchmarks = await getBenchmarks();

  // ItemList + BreadcrumbList JSON-LD so search engines and LLMs see the
  // page as a structured registry (the data is already in the DOM but
  // schema.org markup unlocks Dataset-listing rich results + grounded
  // citation by the LLM tier the rest of the site already optimises for).
  const jsonLd = buildItemListJsonLd({
    name: "OpenChainBench benchmarks",
    url: "https://openchainbench.com/benchmarks",
    description: DESCRIPTION,
    items: benchmarks.map((b) => ({
      name: b.title,
      url: `https://openchainbench.com/benchmarks/${b.slug}`,
    })),
    breadcrumb: [
      { name: "Home", url: "https://openchainbench.com/" },
      { name: "All benchmarks", url: "https://openchainbench.com/benchmarks" },
    ],
  });

  return (
    <article className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
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
