import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { CHAINS, getBenchmarksForChain, type ChainEntry } from "@/lib/chains";
import { SITE } from "@/data/site";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/page-metadata";

const DESCRIPTION =
  "Every blockchain measured by OpenChainBench, with live benchmarks grouped by chain. Pick a chain for the full set of measurements that touch it.";

export const metadata: Metadata = pageMetadata({
  path: "/chains",
  title: "Chains tracked by OpenChainBench",
  description: DESCRIPTION,
});

export const revalidate = 60;

type EnrichedChain = ChainEntry & { benchCount: number };

export default async function ChainsHubPage() {
  const enriched: EnrichedChain[] = await Promise.all(
    CHAINS.map(async (c) => ({
      ...c,
      benchCount: (await getBenchmarksForChain(c.slug)).length,
    })),
  );

  // Filter out chains that don't surface in any bench yet so the hub
  // never sends a crawler to an empty `/chains/<slug>` page.
  const visible = enriched.filter((c) => c.benchCount > 0);

  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "OpenChainBench chains",
    numberOfItems: visible.length,
    itemListElement: visible.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.label,
      url: `${SITE.url}/chains/${c.slug}`,
    })),
  };

  const breadcrumb = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Chains", item: `${SITE.url}/chains` },
    ]),
  };

  const byCategory = new Map<string, EnrichedChain[]>();
  for (const c of visible) {
    const list = byCategory.get(c.category) ?? [];
    list.push(c);
    byCategory.set(c.category, list);
  }

  return (
    <article className="mx-auto max-w-[900px] px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(itemList) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
      />
      <h1 className="display text-3xl sm:text-4xl text-ink leading-[1.05]">
        Chains tracked by OpenChainBench.
      </h1>
      <p className="mt-4 max-w-2xl text-base text-ink-soft leading-snug">
        {DESCRIPTION}
      </p>

      <div className="mt-12 space-y-12">
        {Array.from(byCategory.entries()).map(([category, list]) => (
          <section key={category}>
            <h2 className="text-lg sm:text-xl font-bold tracking-tight text-ink">
              {category}
            </h2>
            <ul className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {list.map((c) => (
                <li key={c.slug}>
                  <Link
                    href={`/chains/${c.slug}`}
                    className="card-soft rounded-xl p-4 flex flex-col gap-1 h-full hover:border-ink/40 transition-colors group"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="display text-base sm:text-lg tracking-tight text-ink leading-tight">
                        {c.label}
                      </span>
                      <ArrowUpRight
                        size={14}
                        strokeWidth={2}
                        className="text-ink-faint group-hover:text-ink shrink-0"
                      />
                    </div>
                    <span className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">
                      {c.benchCount} live benchmark
                      {c.benchCount === 1 ? "" : "s"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </article>
  );
}
