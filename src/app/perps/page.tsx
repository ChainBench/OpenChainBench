import Link from "next/link";
import { fetchPerpByAssetMatrix, fetchPerpCohort } from "@/lib/perp-stats";
import { PerpHubTabs } from "@/components/perp-hub-tabs";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

/**
 * Hub landing page for the perpetual DEX cohort. SSR'd against the
 * `perp_venue_*` gauges exposed by the cross-venue perp cohort harness
 * plus the existing perp bench gauges (perp-fees, perp-funding). One
 * server fetch, one client tab swap between DEX venues and by-asset.
 *
 * The page positions OCB as the neutral cross-venue measurement layer
 * for perp DEXes. Volume and open interest sit alongside the measured
 * execution-quality benches OCB already runs, on the same timeline and
 * with the same methodology. Per-venue pages live on /products/<slug>
 * (PerpVenueSection mirrors the PM venue treatment).
 *
 * The hub renders gracefully before the harness goes live: every
 * numeric field is independently nullable, the leaderboard shows a row
 * of dots for missing data, and the JSON-LD ItemList stays valid
 * because it lists venue identities, not metric values.
 */

const DESCRIPTION =
  "Live volume, open interest, fees, all-in cost and funding rate across 15 perpetual DEXes. Reproducible methodology, refreshed every minute, sources public.";

export const metadata: import("next").Metadata = pageMetadata({
  path: "/perps",
  title:
    "Perpetual DEX leaderboard: Hyperliquid, Lighter, GMX, dYdX, live cross-venue ranking",
  description: DESCRIPTION,
});

export const revalidate = 60;

export default async function PerpsHubPage() {
  // Fetch cohort + per-asset matrix in parallel so the by-asset tab is
  // hydrated on first paint, no second round-trip when the user flips
  // the pill. Both helpers are wrapped in unstable_cache so concurrent
  // requests collapse onto the same Prom roundtrip.
  const [cohort, byAsset] = await Promise.all([
    fetchPerpCohort(),
    fetchPerpByAssetMatrix(),
  ]);

  const breadcrumbLd = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Perpetuals", item: `${SITE.url}/perps` },
    ]),
  };

  // ItemList JSON-LD points at the /products/<slug> page for each
  // venue. The GMX cohort row keys as gmx-v2 (matching the bench
  // harness label), but the product page lives at /products/gmx, so
  // map it here. Keeping this list stable means the SERP card does
  // not churn if the harness drops a series momentarily.
  const top15 = cohort ? cohort.venues.slice(0, 15) : [];
  const itemListLd = cohort
    ? {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: "Perpetual DEXes tracked by OpenChainBench",
        description:
          "Perpetual DEX venues tracked by OpenChainBench, with cross-venue measurements of volume, open interest, fees, all-in cost and funding rate.",
        numberOfItems: top15.length,
        itemListElement: top15.map((r, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: r.name,
          url:
            r.slug === "gmx-v2"
              ? `${SITE.url}/products/gmx`
              : `${SITE.url}/products/${r.slug}`,
        })),
      }
    : null;

  return (
    <article
      className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16"
      style={{
        background:
          "linear-gradient(180deg, rgba(20,184,166,0.05), rgba(20,184,166,0) 320px)",
      }}
    >
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
        <p className="label-mono text-teal-600 mb-2">Perpetuals</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">
          Perpetual DEX leaderboard, measured neutrally.
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          DefiLlama style ranking columns paired with the live execution
          quality benches OCB already runs. {DESCRIPTION}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
          <Link
            href="/benchmarks/perp-fees"
            className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Bench
            </span>
            <span className="text-ink">perp-fees</span>
          </Link>
          <Link
            href="/benchmarks/perp-funding"
            className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Bench
            </span>
            <span className="text-ink">perp-funding</span>
          </Link>
          <Link
            href="/hyperliquid"
            className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Hub
            </span>
            <span className="text-ink">Hyperliquid</span>
          </Link>
          <Link
            href="/methodology"
            className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 px-3 py-1 text-ink-soft hover:text-ink"
          >
            How OpenChainBench measures
          </Link>
        </div>
      </header>

      {cohort ? (
        <>
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <SummaryCard
              label="Tracked venues"
              value={
                cohort.totals.trackedVenues > 0
                  ? `${cohort.totals.trackedVenues} of ${cohort.venues.length}`
                  : `0 of ${cohort.venues.length}`
              }
              accent="#14b8a6"
              tip="Venues with at least a 30 day volume sample in the current cohort run."
            />
            <SummaryCard
              label="Cohort volume 30d"
              value={fmtUSD(cohort.totals.cohortVolume30d)}
              tip="Sum of 30 day notional traded across every venue with a live sample."
            />
            <SummaryCard
              label="Cohort open interest"
              value={fmtUSD(cohort.totals.cohortOpenInterest)}
              tip="Sum of outstanding position notional across every venue with a live sample."
            />
            <SummaryCard
              label="Avg funding ETH 24h"
              value={fmtBpsSigned(cohort.totals.avgFunding24hEth)}
              tip="Cohort average of the 24 hour normalized funding cost on ETH (bench perp-funding). Negative means longs are paid to hold."
            />
          </section>

          <PerpHubTabs cohort={cohort} byAsset={byAsset} />

          <p className="mt-4 text-[11px] text-ink-faint italic">
            Sources: live cohort harness perp-cohort-stats (volume, OI,
            fees, active markets, top market). perp-fees bench (007) for
            the all-in cost column. perp-funding bench (036) for the
            funding column. All gauges scraped from the public OCB Prom,
            refresh interval 60s. Click a venue row to open its
            dedicated product page.
          </p>
        </>
      ) : (
        <p className="text-sm text-ink-faint italic">
          Cohort data is temporarily unavailable. The bench pages are
          still live at{" "}
          <Link href="/benchmarks/perp-fees" className="underline">
            /benchmarks/perp-fees
          </Link>{" "}
          and{" "}
          <Link href="/benchmarks/perp-funding" className="underline">
            /benchmarks/perp-funding
          </Link>
          .
        </p>
      )}

      <footer className="mt-16 pt-6 border-t border-ink/10 text-[12px] text-ink-soft leading-relaxed">
        <p className="label-mono text-ink-faint mb-2">Methodology</p>
        <p>
          Venue rows aggregate the public APIs of each platform,
          normalized to USD and UTC days. All-in fee is the perp-fees
          bench (taker fee plus half-spread plus impact on a $1000 ETH
          10x long, 24h average). Funding is the perp-funding bench
          (normalized to a 24h hold across venues that settle on 1h, 4h
          or 8h intervals). Volume / OI bands are colored to surface
          ratios that diverge from a healthy order-book venue (below
          50x normal, 50 to 200x elevated, above 200x worth a closer
          look).
        </p>
        <p className="mt-3">
          Data and methodology released under{" "}
          <Link
            href="https://creativecommons.org/licenses/by/4.0/"
            className="underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            CC BY 4.0
          </Link>
          . Reuse with attribution to OpenChainBench.
        </p>
      </footer>
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

function fmtUSD(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtBpsSigned(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  const sign = v > 0 ? "+" : "";
  if (Math.abs(v) >= 100) return `${sign}${v.toFixed(0)} bps`;
  return `${sign}${v.toFixed(1)} bps`;
}
