import Link from "next/link";
import {
  fetchHlCohort,
  fetchHlHip3Cohort,
  fetchHlHistory,
} from "@/lib/hl-builder-stats";
import { HlHubTabs } from "@/components/hl-hub-tabs";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/jsonld";

/**
 * Hub landing page for the Hyperliquid revenue cohorts. SSR'd straight
 * against the feed harness' Prom gauges so the first paint is the
 * populated leaderboard (great for SEO and TTFB), with a client-side
 * tab swap between the two cohorts (no second network round-trip).
 *
 * Two cohorts share the page because they describe complementary
 * revenue streams on the same chain:
 *   1. Frontends: builder-code routers (Phantom, Axiom, ...) collecting
 *      a builder fee on every routed perp fill (~104 tracked)
 *   2. HIP-3 dexes: builder-deployed perp markets (trade.xyz, Paragon,
 *      ...) ranked by the chain's 24h notional on their namespaced
 *      markets
 *
 * Per-frontend detail lives on `/products/<slug>#hl` (12-month
 * history + focus chart + KPIs). HIP-3 dexes have no per-dex page yet;
 * the leaderboard is the canonical surface. `/products/<slug>` for a
 * tracked HL builder 308-redirects into the /hyperliquid subtree so the
 * two hubs stop competing for the same rank signal.
 */

const HUB_DESCRIPTION =
  "Revenue, volume and users for every Hyperliquid frontend, plus volume, markets and open interest for every HIP-3 dex. Built from Hyperliquid's public builder fills feed and info API.";

function fmtUsdShort(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

/** One dated sentence both the lede and the meta description use, built
 *  from the live cohort blobs so the snippet names today's leaders
 *  (audit 2026-09-24: the static description carried no number). */
function hubLede(
  frontends: Awaited<ReturnType<typeof fetchHlCohort>>,
  hip3: Awaited<ReturnType<typeof fetchHlHip3Cohort>>,
): { sentence: string; asOf: string } | null {
  const top = frontends?.rows[0];
  const hipTop = hip3?.rows[0];
  if (!top && !hipTop) return null;
  const asOf = new Date((frontends?.asOf ?? hip3?.asOf ?? Date.now() / 1000) * 1000)
    .toISOString()
    .slice(0, 10);
  const parts: string[] = [];
  if (top && frontends) {
    parts.push(
      `${top.name} leads ${frontends.rows.length} Hyperliquid frontends on 30-day builder fees at ${fmtUsdShort(top.revenue30d)}`,
    );
  }
  if (hipTop && hip3) {
    parts.push(
      `${hipTop.name} leads ${hip3.rows.length} HIP-3 dexes on 24h notional at ${fmtUsdShort(hipTop.volume24h)}`,
    );
  }
  return { sentence: `${parts.join("; ")}.`, asOf };
}

export async function generateMetadata(): Promise<import("next").Metadata> {
  const [frontends, hip3] = await Promise.all([fetchHlCohort(), fetchHlHip3Cohort()]);
  const lede = hubLede(frontends, hip3);
  return pageMetadata({
    path: "/hyperliquid",
    title: "Hyperliquid Frontends + HIP-3 Dexes Leaderboard",
    description: lede
      ? `${lede.sentence} Daily, keyless public data.`
      : HUB_DESCRIPTION,
  });
}

export const revalidate = 3600;

export default async function HyperliquidHubPage() {
  const [frontends, hip3, history] = await Promise.all([
    fetchHlCohort(),
    fetchHlHip3Cohort(),
    fetchHlHistory(),
  ]);
  const lede = hubLede(frontends, hip3);

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
  // Drop anonymous builder addresses (raw 0x... slugs with no human
  // brand) from the ItemList. Those /products/<hex> URLs now 404 per the
  // SEO blacklist in @/lib/providers (thin auto-generated titles, no
  // editorial body, no inbound brand demand) so emitting them in
  // schema.org ItemList would point Search Console at known 404s.
  const linkableFrontends = frontends
    ? frontends.rows.filter((r) => !/^0x[a-f0-9]+$/.test(r.slug.toLowerCase()))
    : [];
  const itemListLd = frontends
    ? {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: "Hyperliquid frontends leaderboard",
        description:
          "Hyperliquid frontends tracked by OpenChainBench, ranked by 30-day builder revenue.",
        numberOfItems: linkableFrontends.length,
        itemListElement: linkableFrontends.slice(0, 100).map((r, i) => ({
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
          fills (Phantom, Axiom, ...) and HIP-3 dexes running their own
          namespaced markets (trade.xyz, Paragon, ...). Frontend figures
          come from Hyperliquid&apos;s public per-builder daily fills feed and
          describe the last complete UTC day; HIP-3 figures come from the
          public info API, refreshed every 10 minutes.
        </p>
        {lede && (
          <p className="mt-3 max-w-2xl text-sm text-ink-soft">
            As of {lede.asOf}, {lede.sentence}
          </p>
        )}
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
          <HlHubTabs
            frontends={frontends}
            hip3={hip3}
            history={history}
          />

          <h2 className="label-mono text-ink-muted mt-8">Sources</h2>
          <p className="mt-2 text-[11px] text-ink-faint italic">
            Hyperliquid&apos;s public per-builder daily fills feed
            (stats-data.hyperliquid.xyz) for the frontends cohort, one
            CSV per builder address and UTC day, and the public info API
            (perpDexs, metaAndAssetCtxs) for the HIP-3 cohort. Both
            publish to the same Prom; the bench pages document the
            per-row formulas. The `12m trend` column mirrors the same
            30d fees gauge, one point per UTC day.
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
