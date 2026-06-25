import type { Metadata } from "next";
import { getBenchmarksSafe, toBenchmarkCardData } from "@/data/benchmarks";
import { BenchmarkGrid } from "@/components/benchmark-grid";
import { safeJsonLd, buildItemListJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { pageMetadata } from "@/lib/page-metadata";

export const revalidate = 60;

const DESCRIPTION =
  "Comprehensive registry of open, reproducible benchmarks running across major protocols, bridges and indexers.";

export const metadata: Metadata = pageMetadata({
  path: "/benchmarks",
  title: "All benchmarks",
  description: DESCRIPTION,
});

export default async function BenchmarksPage() {
  const benchmarks = await getBenchmarksSafe();

  // ItemList + BreadcrumbList JSON-LD so search engines and LLMs see the
  // page as a structured registry (the data is already in the DOM but
  // schema.org markup unlocks Dataset-listing rich results + grounded
  // citation by the LLM tier the rest of the site already optimises for).
  const jsonLd = buildItemListJsonLd({
    name: "OpenChainBench benchmarks",
    url: `${SITE.url}/benchmarks`,
    description: DESCRIPTION,
    items: benchmarks.map((b) => ({
      name: b.title,
      url: `${SITE.url}/benchmarks/${b.slug}`,
    })),
    breadcrumb: [
      { name: "Home", url: `${SITE.url}/` },
      { name: "All benchmarks", url: `${SITE.url}/benchmarks` },
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
      <BenchmarkGrid benchmarks={benchmarks.map(toBenchmarkCardData)} />
    </article>
  );
}
