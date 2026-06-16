import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { loadAllAlternatives } from "@/lib/alternatives";
import { SITE } from "@/data/site";
import { safeJsonLd } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/page-metadata";

const DESCRIPTION =
  "Alternatives to crypto infrastructure products, ranked by live OpenChainBench measurements. Same benchmark data, reframed per product, no verdict.";

// Same as /compare: go through pageMetadata so the Twitter Card and OG
// image fall back to the branded root cards instead of emitting a
// generic "OpenChainBench" twitter:title and no og:image.
export const metadata: Metadata = pageMetadata({
  path: "/alternatives",
  title: "Alternatives by the numbers",
  description: DESCRIPTION,
});

export default async function AlternativesPage() {
  const alternatives = await loadAllAlternatives();

  const jsonld = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Product alternatives on OpenChainBench",
    itemListElement: alternatives.map((alt, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: `${alt.target_product} alternatives`,
      url: `${SITE.url}/alternatives/${alt.slug}`,
    })),
  };

  return (
    <article className="mx-auto max-w-[900px] px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonld) }}
      />
      <h1 className="display text-3xl sm:text-4xl text-ink leading-[1.05]">
        Alternatives by the numbers.
      </h1>
      <p className="mt-4 max-w-2xl text-base text-ink-soft leading-snug">
        Each page below reuses a live OpenChainBench benchmark to answer one
        question: what else measures up against this product? Same data, same
        methodology, no editorial verdict.
      </p>

      <ul className="mt-10 divide-y divide-rule border-y border-rule">
        {alternatives.map((alt) => (
          <li key={alt.slug}>
            <Link
              href={`/alternatives/${alt.slug}`}
              className="group flex items-center justify-between gap-4 py-4 hover:bg-surface transition-colors"
            >
              <span className="min-w-0">
                <span className="block text-lg text-ink font-semibold">
                  {alt.target_product} alternatives
                </span>
                <span className="mt-0.5 block text-sm text-ink-muted truncate">
                  {alt.description}
                </span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-sm uppercase tracking-wide text-ink-soft group-hover:text-ink transition-colors">
                View data
                <ArrowUpRight size={14} strokeWidth={2} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </article>
  );
}
