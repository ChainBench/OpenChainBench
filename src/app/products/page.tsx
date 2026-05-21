import { getProviders } from "@/lib/providers";
import { ProvidersTable } from "@/components/providers-table";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/jsonld";

export const metadata: import("next").Metadata = pageMetadata({
  path: "/products",
  title: "Products",
  description:
    "Every product tracked by OpenChainBench, grouped by performance. Click a name for its full benchmark record.",
});

export const revalidate = 60;

export default async function ProvidersIndex() {
  const providers = await getProviders();
  const rows = providers.map((p) => ({
    slug: p.slug,
    name: p.name,
    type: p.type,
    appearances: p.appearances.length,
    wins: p.wins,
    categories: p.categories,
  }));

  const itemListLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "OpenChainBench products",
    description:
      "Every product that appears in at least one OpenChainBench benchmark.",
    numberOfItems: providers.length,
    itemListElement: providers.map((p, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `https://openchainbench.com/products/${p.slug}`,
      name: p.name,
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
        name: "Products",
        item: "https://openchainbench.com/products",
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
        <h1 className="display text-4xl sm:text-5xl text-ink">Products</h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Every product that appears in at least one live benchmark.
          Sorted by number of #1 finishes, then by reach across categories.
        </p>
      </header>
      <ProvidersTable providers={rows} />
    </article>
  );
}
