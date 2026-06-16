import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { COMPARE_PAIRS } from "@/data/compare-pairs";
import { canonicalize } from "@/lib/providers";
import { SITE } from "@/data/site";
import { safeJsonLd } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/page-metadata";

const DESCRIPTION =
  "Head-to-head benchmark data for crypto infrastructure providers. Every pair measured side by side on shared OpenChainBench benchmarks. Live data, no verdict.";

// Go through pageMetadata so the Twitter Card and OG image fall back to
// the branded root cards. Without this, /compare emitted a generic
// twitter:title ("OpenChainBench") and no og:image, so every X share
// previewed as a blank.
export const metadata: Metadata = pageMetadata({
  path: "/compare",
  title: "Compare providers head to head",
  description: DESCRIPTION,
});

export default function ComparePage() {
  const pairs = [...COMPARE_PAIRS].sort((a, b) =>
    a.slug.localeCompare(b.slug),
  );

  const jsonld = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Provider comparisons on OpenChainBench",
    itemListElement: pairs.map((pair, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: `${canonicalize(pair.providerA).name} vs ${canonicalize(pair.providerB).name}`,
      url: `${SITE.url}/compare/${pair.slug}`,
    })),
  };

  return (
    <article className="mx-auto max-w-[900px] px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonld) }}
      />
      <h1 className="display text-3xl sm:text-4xl text-ink leading-[1.05]">
        Compare providers head to head.
      </h1>
      <p className="mt-4 max-w-2xl text-base text-ink-soft leading-snug">
        Every pair below competes on at least one shared OpenChainBench
        benchmark. Each page shows the same live measurements for both
        providers, side by side, with no verdict.
      </p>

      <section className="mt-12">
        <h2 className="text-lg sm:text-xl font-bold tracking-tight text-ink">
          All featured comparisons
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft leading-snug">
          {pairs.length} hand-picked head-to-heads between providers that
          appear in at least one common benchmark.
        </p>
        <ul className="mt-6 divide-y divide-rule border-y border-rule">
          {pairs.map((pair) => {
            const a = canonicalize(pair.providerA).name;
            const b = canonicalize(pair.providerB).name;
            return (
              <li key={pair.slug}>
                <Link
                  href={`/compare/${pair.slug}`}
                  className="group flex items-center justify-between gap-4 py-4 hover:bg-surface transition-colors"
                >
                  <span className="text-lg text-ink font-semibold">
                    {a}{" "}
                    <span className="text-ink-soft font-normal">vs</span> {b}
                  </span>
                  <span className="inline-flex items-center gap-1 text-sm uppercase tracking-wide text-ink-soft group-hover:text-ink transition-colors">
                    View data
                    <ArrowUpRight size={14} strokeWidth={2} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </article>
  );
}
