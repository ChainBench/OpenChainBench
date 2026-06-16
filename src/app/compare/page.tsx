import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { COMPARE_PAIRS } from "@/data/compare-pairs";
import { canonicalize } from "@/lib/providers";
import { ProviderLogo } from "@/components/provider-logo";
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

      <section className="mt-14">
        <h2 className="text-lg sm:text-xl font-bold tracking-tight text-ink">
          All featured comparisons
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft leading-snug">
          {pairs.length} hand-picked head-to-heads between providers that
          appear in at least one common benchmark.
        </p>
        <ul className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {pairs.map((pair) => {
            const a = canonicalize(pair.providerA);
            const b = canonicalize(pair.providerB);
            return (
              <li key={pair.slug}>
                <Link
                  href={`/compare/${pair.slug}`}
                  className="card-soft rounded-xl p-4 flex items-center gap-4 h-full hover:border-ink/40 transition-colors group"
                >
                  <div className="flex items-center -space-x-2 shrink-0">
                    <ProviderLogo slug={a.slug} name={a.name} size={36} />
                    <ProviderLogo slug={b.slug} name={b.name} size={36} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="display text-base sm:text-lg tracking-tight text-ink leading-tight truncate">
                      {a.name}{" "}
                      <span className="text-ink-faint font-normal">vs</span>{" "}
                      {b.name}
                    </p>
                    <p className="mt-0.5 font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                      Head to head
                    </p>
                  </div>
                  <ArrowUpRight
                    size={16}
                    strokeWidth={2}
                    className="text-ink-faint group-hover:text-ink shrink-0 transition-colors"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </article>
  );
}
