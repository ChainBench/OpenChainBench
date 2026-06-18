import Link from "next/link";
import { fetchHlCohort, fetchHlHip3Cohort } from "@/lib/hl-builder-stats";
import { HlHubTabs } from "@/components/hl-hub-tabs";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/jsonld";

/**
 * Hub landing page for the Hyperliquid revenue cohorts. SSR'd straight
 * against the on-node harness' Prom gauges so the first paint is the
 * populated leaderboard (great for SEO and TTFB), with a client-side
 * tab swap between the two cohorts (no second network round-trip).
 *
 * Two cohorts share the page because they describe complementary
 * revenue streams on the same chain:
 *   1. Frontends: builder-code routers (Phantom, Axiom, ...) collecting
 *      a builder fee on every routed perp fill (~104 tracked)
 *   2. HIP-3 dexes: builder-deployed perp markets (trade.xyz, Dreamcash,
 *      ...) collecting a deployer fee on every fill on their namespaced
 *      markets
 *
 * Per-frontend dashboards live at `/products/<slug>` (Hyperliquid
 * builders only). HIP-3 dexes have no per-dex page yet; the leaderboard
 * is the canonical surface.
 */

export const metadata: import("next").Metadata = pageMetadata({
  path: "/hyperliquid",
  title: "Hyperliquid Frontends + HIP-3 Dexes Leaderboard",
  description:
    "Live revenue, volume and users for every Hyperliquid frontend and HIP-3 deployer. Server-side data straight from a local hl node tailing every fill on mainnet.",
});

export const revalidate = 60;

export default async function HyperliquidHubPage() {
  const [frontends, hip3] = await Promise.all([
    fetchHlCohort(),
    fetchHlHip3Cohort(),
  ]);

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
        name: "Hyperliquid",
        item: "https://openchainbench.com/hyperliquid",
      },
    ],
  };

  // ItemList JSON-LD covers the frontends cohort (the canonical leaderboard
  // for SEO intent "hyperliquid frontends leaderboard"). HIP-3 dex names
  // are referenced in the page's plain prose and stayed out of this list
  // intentionally; mixing two ItemLists with overlapping naming would
  // confuse Search Console's rich-results validator more than it helps.
  const itemListLd = frontends
    ? {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: "Hyperliquid frontends leaderboard",
        description:
          "Hyperliquid frontends tracked by OpenChainBench, ranked by 30-day builder revenue.",
        numberOfItems: frontends.rows.length,
        itemListElement: frontends.rows.slice(0, 100).map((r, i) => ({
          "@type": "ListItem",
          position: i + 1,
          url: `https://openchainbench.com/products/${r.slug}`,
          name: r.name,
        })),
      }
    : null;

  return (
    <article className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbLd) }}
      />
      {itemListLd && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListLd) }}
        />
      )}

      <header className="mb-8">
        <p className="label-mono text-ink-faint mb-2">Hyperliquid</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">
          Hyperliquid revenue leaderboards
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Two complementary cohorts: builder-code frontends routing perp
          fills (Phantom, Axiom, ...) and HIP-3 deployer dexes running
          their own namespaced markets (trade.xyz, Dreamcash, ...). Data
          flows from a local hl node tailing every fill on mainnet,
          refreshed every 30 seconds.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
          <Link
            href="/benchmarks/hyperliquid-frontends"
            className="inline-flex items-center gap-1.5 rounded-full border border-ink/15 px-3 py-1 hover:bg-paper-soft/60"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Methodology
            </span>
            <span className="text-ink">hyperliquid-frontends bench →</span>
          </Link>
          <Link
            href="/benchmarks/hyperliquid-hip3-deployers"
            className="inline-flex items-center gap-1.5 rounded-full border border-ink/15 px-3 py-1 hover:bg-paper-soft/60"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Methodology
            </span>
            <span className="text-ink">hyperliquid-hip3-deployers bench →</span>
          </Link>
          <Link
            href="/methodology"
            className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 px-3 py-1 text-ink-soft hover:text-ink"
          >
            How OpenChainBench measures
          </Link>
        </div>
      </header>

      {frontends || hip3 ? (
        <>
          <HlHubTabs frontends={frontends} hip3={hip3} />

          <p className="mt-4 text-[11px] text-ink-faint italic">
            Source: a local hl node tailing every fill on Hyperliquid
            mainnet. Frontends cohort attributes fills via the on-chain
            builder address; HIP-3 cohort attributes fills via the dex
            namespace prefix on the coin field (xyz:AAPL → xyz). Both
            cohorts publish to the same Prom; the bench pages document
            the per-row formulas.
          </p>
        </>
      ) : (
        <p className="text-sm text-ink-faint italic">
          Cohort data is temporarily unavailable. The bench pages are still
          live at{" "}
          <Link
            href="/benchmarks/hyperliquid-frontends"
            className="underline"
          >
            /benchmarks/hyperliquid-frontends
          </Link>{" "}
          and{" "}
          <Link
            href="/benchmarks/hyperliquid-hip3-deployers"
            className="underline"
          >
            /benchmarks/hyperliquid-hip3-deployers
          </Link>
          .
        </p>
      )}
    </article>
  );
}
