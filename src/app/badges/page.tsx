import Link from "next/link";
import type { Metadata } from "next";
import { getBenchmarksSafe } from "@/data/benchmarks";
import { BadgesCatalog, type BadgePair } from "@/components/badges-catalog";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

/**
 * Public discovery page for the per-(benchmark, provider) badge endpoints.
 *
 * The /api/badge/<bench>/<provider> route has been live for months and
 * powers per-row embed buttons on bench pages and the /partners docs,
 * but nothing on the site lets a visitor browse what is available.
 * This page is the shields.io-style catalog: search, filter, preview,
 * copy. Also doubles as a backlink generator: every embedded snippet
 * is one more link back to a bench page.
 *
 * Loads from `getBenchmarksSafe` so a Prom blackout still renders the
 * shell with whatever the carry-forward snapshot holds. Pairs that
 * have no live rank are filtered out so the page never advertises a
 * "rank N/A" badge.
 */

export const revalidate = 600;

const DESCRIPTION =
  "Every OpenChainBench ranking badge. Search, preview the SVG, copy Markdown, HTML, URL or JSON for your README or docs. CC-BY-4.0.";

export const metadata: Metadata = pageMetadata({
  path: "/badges",
  title: "Live ranking badges",
  description: DESCRIPTION,
});

/** Hand-picked example pairs surfaced in the hero preview row. Each one
 *  is a recognisable leader the page can safely showcase. Pairs missing
 *  from the live snapshot (provider absent, bench in draft) are silently
 *  skipped so a transient outage doesn't break the layout. */
const PREVIEW_PAIRS: Array<{ bench: string; provider: string }> = [
  { bench: "bridge-fee", provider: "mobula" },
  { bench: "perp-fees", provider: "lighter" },
  { bench: "rpc-capabilities", provider: "drpc" },
  { bench: "nft-collection-metadata", provider: "moralis" },
  { bench: "pm-api-latency", provider: "polymarket" },
];

export default async function BadgesPage() {
  const benchmarks = await getBenchmarksSafe();

  const live = benchmarks.filter((b) => b.editorialStatus === "live");

  // Flat list of (bench, provider) pairs the catalog can browse. Each
  // entry carries the ranked position so the card can flash "#1/12"
  // without an extra fetch. Sort order: best ranks first inside each
  // bench, benches grouped alphabetically by category then title.
  const pairs: BadgePair[] = [];
  for (const b of live) {
    const livePr = b.results.filter((r) => r.ms.p50 > 0);
    if (livePr.length === 0) continue;
    const sorted = [...livePr].sort((a, c) =>
      b.higherIsBetter ? c.ms.p50 - a.ms.p50 : a.ms.p50 - c.ms.p50,
    );
    sorted.forEach((r, idx) => {
      pairs.push({
        benchSlug: b.slug,
        benchTitle: b.title,
        benchCategory: b.category,
        providerSlug: r.slug,
        providerName: r.name,
        rank: idx + 1,
        total: sorted.length,
        dimensions: {
          chain: b.dimensions?.chain,
          region: b.dimensions?.region,
        },
      });
    });
  }
  pairs.sort((a, b) => {
    if (a.benchCategory !== b.benchCategory)
      return a.benchCategory.localeCompare(b.benchCategory);
    if (a.benchTitle !== b.benchTitle)
      return a.benchTitle.localeCompare(b.benchTitle);
    return a.rank - b.rank;
  });

  // Lookup table so the hero preview row can resolve the canonical
  // provider name + alt text without a second pass over the snapshot.
  const pairKey = (bench: string, provider: string) => `${bench}|${provider}`;
  const pairIndex = new Map(
    pairs.map((p) => [pairKey(p.benchSlug, p.providerSlug), p]),
  );
  const previewItems = PREVIEW_PAIRS.map((p) =>
    pairIndex.get(pairKey(p.bench, p.provider)),
  ).filter((p): p is BadgePair => Boolean(p));

  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "OpenChainBench live ranking badges",
    description: DESCRIPTION,
    url: `${SITE.url}/badges`,
    isPartOf: {
      "@type": "WebSite",
      name: SITE.name,
      url: SITE.url,
    },
    mainEntity: {
      "@type": "ItemList",
      name: "OpenChainBench badges",
      numberOfItems: pairs.length,
      itemListElement: pairs.slice(0, 100).map((p, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: `${p.providerName} on ${p.benchTitle}`,
        url: `${SITE.url}/api/badge/${p.benchSlug}/${p.providerSlug}`,
      })),
    },
  };

  const breadcrumbLd = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Badges", item: `${SITE.url}/badges` },
    ]),
  };

  return (
    <article className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(collectionLd) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbLd) }}
      />

      {/* Section 1: hero */}
      <header className="mb-12 max-w-3xl">
        <p className="label-mono text-ink-faint mb-2">Embeds</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">
          Live ranking badges
        </h1>
        <p className="mt-4 text-base sm:text-lg text-ink-soft leading-snug">
          Embed your live OpenChainBench rank in your README, docs, or
          marketing page. Every badge auto-refreshes when our benchmarks
          run. Free, no signup.
        </p>
      </header>

      {/* Section 2: live preview row */}
      {previewItems.length > 0 && (
        <section aria-label="Featured badges" className="mb-14">
          <p className="label-mono text-ink-faint mb-3">Live examples</p>
          <ul className="flex flex-wrap gap-3">
            {previewItems.map((p) => (
              <li key={pairKey(p.benchSlug, p.providerSlug)}>
                <Link
                  href={`/benchmarks/${p.benchSlug}`}
                  className="inline-block rounded border border-rule bg-paper-soft p-2 hover:border-ink/40 transition-colors"
                  aria-label={`See ${p.providerName} on ${p.benchTitle}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/badge/${p.benchSlug}/${p.providerSlug}`}
                    alt={`Live badge for ${p.providerName} on ${p.benchTitle}`}
                    className="max-w-full h-auto"
                    loading="eager"
                    decoding="async"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Section 3: catalog */}
      <section aria-label="Badge catalog">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="display text-2xl sm:text-3xl text-ink">
              Catalog
            </h2>
            <p className="mt-2 text-sm text-ink-soft max-w-2xl">
              One card per (provider, benchmark) pair. {pairs.length}{" "}
              badges across {live.length} benchmarks. Click a card for
              the embed snippet.
            </p>
          </div>
        </header>
        <BadgesCatalog pairs={pairs} />
      </section>

      {/* Section 5: footer */}
      <footer className="mt-16 border-t border-rule pt-8 flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-ink-soft max-w-xl">
          Built for providers who want to display real, third-party
          verified rankings.
        </p>
        <ul className="flex flex-wrap items-center gap-4 text-sm">
          <li>
            <Link href="/methodology" className="lnk text-ink-muted hover:text-ink">
              View methodology
            </Link>
          </li>
          <li>
            <Link href="/benchmarks" className="lnk text-ink-muted hover:text-ink">
              View all benchmarks
            </Link>
          </li>
          <li>
            <Link href="/partners" className="lnk text-ink-muted hover:text-ink">
              Partner docs
            </Link>
          </li>
        </ul>
      </footer>
    </article>
  );
}
