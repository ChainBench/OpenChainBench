import type { Metadata } from "next";
import { getBenchmarksSafe, toBenchmarkCardData } from "@/data/benchmarks";
import { isThinRpcBench, isExpiredRpcPage } from "@/lib/provider-filters";
import { BenchmarkGrid } from "@/components/benchmark-grid";
import { safeJsonLd } from "@/lib/jsonld";

export const revalidate = 3600;

const DESCRIPTION =
  "Live benchmarks on RPC latency, perp DEX fees and volume, bridge cost, L1 finality and oracle deviation, measured continuously with an open methodology.";

export const metadata: Metadata = {
  title: "Crypto infrastructure benchmarks 2026: RPC, perps, bridges",
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
  // Thin chain RPC benches (< 3 providers) are noindex on their own page;
  // the index does not link them (see isThinRpcBench).
  const benchmarks = (await getBenchmarksSafe()).filter((b) => !isThinRpcBench(b) && !isExpiredRpcPage(b));

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
      <BenchmarkGrid benchmarks={benchmarks.map(toBenchmarkCardData)} />
    </article>
  );
}
