import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getBenchmarksSafe } from "@/data/benchmarks";
import { BenchmarkGrid } from "@/components/benchmark-grid";
import { Breadcrumb } from "@/components/breadcrumb";
import { safeJsonLd, buildItemListJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { pageMetadata } from "@/lib/page-metadata";
import { capDescription } from "@/lib/seo-text";
import { CATEGORIES, CATEGORY_BY_SLUG } from "@/lib/categories";

/**
 * Per-category hub page. One static route per entry in `CATEGORIES` so
 * each architectural slice (RPCs, Bridges, Blockchains, ...) has a
 * crawlable, linkable URL. Lets external sites and internal nav deep
 * link directly into "all Solana RPC benchmarks" instead of relying on
 * the client-only filter that lives on `/benchmarks`.
 *
 * Prerendered at build time via `generateStaticParams` (closed list, no
 * Prom calls needed). ISR refresh aligned with the main hub so a freshly
 * added bench surfaces here on the same cadence.
 */

export const revalidate = 60;

type Params = { cat: string };

export async function generateStaticParams() {
  // Closed enum, generated even when a category currently has zero live
  // benches (e.g. Wallets at time of writing). The page-level fallback
  // below 404s empty categories so crawlers don't index thin pages.
  return CATEGORIES.map((c) => ({ cat: c.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { cat } = await params;
  const entry = CATEGORY_BY_SLUG.get(cat);
  if (!entry) return {};
  const description = capDescription(entry.description, 158);
  return pageMetadata({
    path: `/benchmarks/category/${entry.slug}`,
    title: `${entry.heading}`,
    description,
  });
}

export default async function BenchmarkCategoryPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { cat } = await params;
  const entry = CATEGORY_BY_SLUG.get(cat);
  if (!entry) notFound();

  const all = await getBenchmarksSafe();
  const benchmarks = all.filter((b) => b.category === entry.label);
  // Empty-category guard: a category in the enum that has no live bench
  // yet returns 404 so the crawler doesn't land on a thin page. The
  // category still ships in `generateStaticParams` so adding the first
  // bench to it lights up the URL without a redeploy gate.
  if (benchmarks.length === 0) notFound();

  const url = `${SITE.url}/benchmarks/category/${entry.slug}`;
  const jsonLd = buildItemListJsonLd({
    name: `${entry.heading} on OpenChainBench`,
    url,
    description: entry.description,
    items: benchmarks.map((b) => ({
      name: b.title,
      url: `${SITE.url}/benchmarks/${b.slug}`,
    })),
    breadcrumb: [
      { name: "Home", url: `${SITE.url}/` },
      { name: "All benchmarks", url: `${SITE.url}/benchmarks` },
      { name: entry.heading, url },
    ],
  });

  return (
    <article className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      <Breadcrumb
        items={[
          { label: "Benchmarks", href: "/benchmarks" },
          { label: entry.heading },
        ]}
      />
      <header className="mb-10 mt-4">
        <h1 className="display text-4xl sm:text-5xl text-ink">
          {entry.heading}
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          {entry.description}
        </p>
      </header>
      <BenchmarkGrid benchmarks={benchmarks} lockedCategory={entry.label} />
    </article>
  );
}
