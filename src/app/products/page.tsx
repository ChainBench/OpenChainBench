import { getProviders } from "@/lib/providers";
import { ProvidersTable } from "@/components/providers-table";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildItemListJsonLd } from "@/lib/jsonld";

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

  const jsonLd = buildItemListJsonLd({
    name: "OpenChainBench products",
    url: "https://openchainbench.com/products",
    description:
      "Every product that appears in at least one OpenChainBench benchmark.",
    items: providers.map((p) => ({
      name: p.name,
      url: `https://openchainbench.com/products/${p.slug}`,
    })),
    breadcrumb: [
      { name: "Home", url: "https://openchainbench.com/" },
      { name: "Products", url: "https://openchainbench.com/products" },
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
        <h1 className="display text-4xl sm:text-5xl text-ink">Products</h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Every product that appears in at least one live benchmark.
          Sorted by number of #1 finishes, then by reach across categories.
        </p>
      </header>

      <section>
        <h2 className="text-lg sm:text-xl font-bold tracking-tight text-ink">
          All tracked products
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft leading-snug">
          {providers.length} crypto infrastructure providers ranked across
          the full OpenChainBench surface. Click a row for the provider&apos;s
          live benchmark record.
        </p>
        <div className="mt-6">
          <ProvidersTable providers={rows} />
        </div>
      </section>
    </article>
  );
}
