import Link from "next/link";
import { fetchHlCohort } from "@/lib/hl-builder-stats";
import { HlCohortLeaderboard } from "@/components/hl-cohort-leaderboard";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/jsonld";

/**
 * Hub landing page for the 104 tracked Hyperliquid frontends. SSR'd
 * straight against the on-node harness' Prom gauges so the first paint
 * is the populated leaderboard (great for SEO and TTFB) and the client
 * bundle only handles sort + search interactions.
 *
 * Sits next to the per-builder pages (`/products/<slug>`), it doesn't
 * replace them. Backlinks to /products/ stay canonical, the hub is
 * the new entry point for cohort-level intent ("hyperliquid frontends
 * leaderboard").
 */

export const metadata: import("next").Metadata = pageMetadata({
  path: "/hyperliquid",
  title: "Hyperliquid Frontends Leaderboard",
  description:
    "Live revenue, volume, users and cohort share for every Hyperliquid frontend. Server-side data straight from a local hl node tailing every fill on mainnet.",
});

export const revalidate = 60;

export default async function HyperliquidHubPage() {
  const cohort = await fetchHlCohort();

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

  const itemListLd = cohort
    ? {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: "Hyperliquid frontends leaderboard",
        description:
          "Hyperliquid frontends tracked by OpenChainBench, ranked by 30-day builder revenue.",
        numberOfItems: cohort.rows.length,
        itemListElement: cohort.rows.slice(0, 100).map((r, i) => ({
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
          Hyperliquid frontends leaderboard
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Every frontend routing builder fills on Hyperliquid mainnet, ranked
          by 30-day builder revenue. Data flows from a local hl node tailing
          every fill, refreshed every 30 seconds. Click any row for the
          builder&apos;s full performance dashboard.
        </p>
      </header>

      {cohort ? (
        <>
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <SummaryCard
              label="Tracked builders"
              value={cohort.rows.length.toLocaleString("en-US")}
              accent="#9d65ff"
            />
            <SummaryCard
              label="Cohort revenue 30d"
              value={fmtUSD(cohort.totalRevenue30d)}
            />
            <SummaryCard
              label="Cohort volume 30d"
              value={fmtUSD(cohort.totalVolume30d)}
            />
            <SummaryCard
              label="Cumulative users 30d"
              value={fmtCount(cohort.totalUsers30d)}
              tip="Sum across builders. A wallet active on two frontends is counted twice (HyperTracker uses the same convention)."
            />
          </section>

          <HlCohortLeaderboard rows={cohort.rows} />

          <p className="mt-4 text-[11px] text-ink-faint italic">
            Source: a local hl node tailing every fill on Hyperliquid mainnet
            for the {cohort.rows.length} tracked builder addresses. Methodology
            and per-builder formulas:{" "}
            <Link
              href="/benchmarks/hyperliquid-frontends"
              className="underline"
            >
              hyperliquid-frontends bench page
            </Link>
            .
          </p>
        </>
      ) : (
        <p className="text-sm text-ink-faint italic">
          Cohort data is temporarily unavailable. The bench page is still
          live at{" "}
          <Link
            href="/benchmarks/hyperliquid-frontends"
            className="underline"
          >
            /benchmarks/hyperliquid-frontends
          </Link>
          .
        </p>
      )}
    </article>
  );
}

function SummaryCard({
  label,
  value,
  accent,
  tip,
}: {
  label: string;
  value: string;
  accent?: string;
  tip?: string;
}) {
  return (
    <div
      className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15"
      title={tip}
    >
      <p
        className="label-mono text-[10px] text-ink-faint mb-1 flex items-center gap-1.5"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {accent && (
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: accent }}
          />
        )}
        {label}
      </p>
      <p className="text-lg sm:text-2xl font-semibold tabular-nums leading-tight">
        {value}
      </p>
    </div>
  );
}

function fmtUSD(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtCount(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}
