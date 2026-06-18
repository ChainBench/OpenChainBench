import type { Metadata } from "next";
import { ArrowUpRight } from "lucide-react";
import { loadAllAlternatives } from "@/lib/alternatives";
import { ProviderLogo } from "@/components/provider-logo";
import { LogoCardLink } from "@/components/logo-card-link";
import { SITE } from "@/data/site";
import { buildItemListJsonLd, safeJsonLd } from "@/lib/jsonld";
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

  const jsonld = buildItemListJsonLd({
    name: "Product alternatives on OpenChainBench",
    url: `${SITE.url}/alternatives`,
    items: alternatives.map((alt) => ({
      name: `${alt.target_product} alternatives`,
      url: `${SITE.url}/alternatives/${alt.slug}`,
    })),
  });

  return (
    <article className="mx-auto max-w-[900px] px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonld) }}
      />
      <h1 className="h1-hero">
        Alternatives by the numbers.
      </h1>
      <p className="mt-4 max-w-2xl text-base text-ink-soft leading-snug">
        Each page below reuses a live OpenChainBench benchmark to answer one
        question: what else measures up against this product? Same data, same
        methodology, no editorial verdict.
      </p>

      <section className="mt-14">
        <h2 className="text-lg sm:text-xl font-bold tracking-tight text-ink">
          All product alternatives
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft leading-snug">
          {alternatives.length} pages reframing OpenChainBench benchmarks
          around a single product, ranked by live measurement.
        </p>
        <ul className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {alternatives.map((alt) => (
            <li key={alt.slug}>
              <LogoCardLink
                href={`/alternatives/${alt.slug}`}
                variant="compact"
                title={`${alt.target_product} alternatives`}
                subtitle={alt.description}
                logo={
                  <ProviderLogo
                    slug={alt.slug}
                    name={alt.target_product}
                    size={40}
                  />
                }
                rightSlot={
                  <ArrowUpRight
                    size={16}
                    strokeWidth={2}
                    className="text-ink-faint group-hover:text-ink transition-colors"
                  />
                }
              />
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
