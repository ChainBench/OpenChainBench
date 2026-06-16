import type { Metadata } from "next";
import Link from "next/link";
import { getBenchmarks } from "@/data/benchmarks";
import { BenchmarkGrid } from "@/components/benchmark-grid";
import { safeJsonLd } from "@/lib/jsonld";
import type { Benchmark } from "@/types/benchmark";

export const revalidate = 60;

const DESCRIPTION =
  "Comprehensive registry of open, reproducible benchmarks running across major protocols, bridges and indexers.";

/** Per-category lede copy shown above the H2 section listing each
 *  benchmark in that category. Pure SEO additive: provides crawl-friendly
 *  context to the h3 anchors below it, and gives each category page-level
 *  semantic weight without breaking the interactive grid above. */
const CATEGORY_LEDE: Record<string, string> = {
  Aggregators:
    "Data API providers measured on head lag from on-chain event to feed emission, metadata coverage across fresh launches, network coverage breadth and swap quote latency.",
  Bridges:
    "Cross-chain bridge providers measured on quote latency and effective fee for $300 USDC corridors, plus implied protocol revenue from observable on-chain flow.",
  Blockchains:
    "Layer 1 and Layer 2 chains measured on finality time, sequencer block time and native transfer fee in dollars, across the full L1 and L2 cohorts OpenChainBench tracks.",
  RPCs:
    "Public RPC infrastructure measured on free-tier latency, capability surface across EVM chains and gas oracle prediction accuracy against the realized priority fee market.",
  Trading:
    "Trading infrastructure measured on perp DEX fees and funding, Solana transaction landing latency, oracle deviation, stablecoin peg deviation and Polymarket rate limits.",
};

function groupByCategory(benchmarks: Benchmark[]): Map<string, Benchmark[]> {
  const out = new Map<string, Benchmark[]>();
  for (const b of benchmarks) {
    const list = out.get(b.category) ?? [];
    list.push(b);
    out.set(b.category, list);
  }
  return out;
}

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
  const itemListLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "OpenChainBench benchmarks",
    description: DESCRIPTION,
    numberOfItems: benchmarks.length,
    itemListOrder: "https://schema.org/ItemListOrderAscending",
    itemListElement: benchmarks.map((b, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `https://openchainbench.com/benchmarks/${b.slug}`,
      name: b.title,
    })),
  };

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: "https://openchainbench.com/",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "All benchmarks",
        item: "https://openchainbench.com/benchmarks",
      },
    ],
  };

  return (
    <article className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListLd) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbLd) }}
      />
      <header className="mb-10">
        <h1 className="display text-4xl sm:text-5xl text-ink">All benchmarks</h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          {DESCRIPTION}
        </p>
      </header>
      <BenchmarkGrid benchmarks={benchmarks} />

      {/* Server-rendered category sections. The BenchmarkGrid above is the
          interactive UI; the H2-grouped listing below provides the semantic
          hierarchy crawlers (and AI Overviews) read off the page. Each
          section is a self-contained set: h2 (category, keyword anchored),
          1-2 sentence lede explaining what the category measures, and a
          ul of every benchmark in that category with descriptive anchor
          text (the bench title, not the slug). */}
      <section className="mt-20 border-t border-rule pt-12">
        <h2 className="display text-2xl sm:text-3xl tracking-tight text-ink">
          Browse benchmarks by category
        </h2>
        <p className="mt-3 max-w-2xl text-base text-ink-soft leading-snug">
          Five categories cover the OpenChainBench surface. Pick a category
          for the cluster of benchmarks measuring it, or use the grid above
          for the live leaderboard cards.
        </p>
        <div className="mt-10 space-y-14">
          {Array.from(groupByCategory(benchmarks).entries()).map(
            ([category, benches]) => (
              <section key={category} id={category.toLowerCase()}>
                <h3 className="text-lg sm:text-xl font-bold tracking-tight text-ink">
                  {category} benchmarks
                </h3>
                {CATEGORY_LEDE[category] && (
                  <p className="mt-2 max-w-3xl text-sm sm:text-base text-ink-soft leading-snug">
                    {CATEGORY_LEDE[category]}
                  </p>
                )}
                <ul className="mt-4 divide-y divide-rule border-y border-rule">
                  {benches.map((b) => (
                    <li key={b.slug}>
                      <Link
                        href={`/benchmarks/${b.slug}`}
                        className="group flex items-center justify-between gap-4 py-3 hover:bg-surface transition-colors"
                      >
                        <span className="text-base text-ink-soft group-hover:text-ink">
                          {b.title}
                        </span>
                        <span className="text-[11px] uppercase tracking-[0.16em] text-ink-faint shrink-0">
                          {b.results.length} providers
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ),
          )}
        </div>
      </section>
    </article>
  );
}
