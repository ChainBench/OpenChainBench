import Link from "next/link";
import { fetchDataApiSnapshot, GROUP_META, fmtDataValue } from "@/lib/data-api-stats";
import { DataApiHubTabs } from "@/components/data-api-hub-tabs";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

/**
 * Hub landing page for the data API vertical: price feeds, token metadata,
 * portfolio/wallet indexing, DEX coverage, and NFT data.
 *
 * Blob-only: loads the materialized bench blobs for each of the 9 data-API
 * benchmarks. Never touches Prometheus at render time. Graceful degradation
 * if blobs are missing — the page renders the "warming up" state with direct
 * bench links, never a 404 or throw.
 */

const DESCRIPTION =
  "Live benchmark rankings for crypto data APIs: price feed latency, token metadata coverage, wallet indexing freshness, DEX chain coverage, and NFT data quality.";

export const metadata: import("next").Metadata = pageMetadata({
  path: "/data-api",
  title: "Best Crypto Data API 2026, ranked by benchmark",
  description: DESCRIPTION,
});

export const revalidate = 60;

const BENCH_SLUGS = [
  "aggregator-head-lag",
  "metadata-coverage",
  "asset-registry-coverage",
  "token-quote-coverage",
  "indexing-freshness",
  "portfolio-chain-coverage",
  "wallet-labels-coverage",
  "dex-network-coverage",
  "nft-collection-metadata",
] as const;

export default async function DataApiHubPage() {
  const snapshot = await fetchDataApiSnapshot();

  const breadcrumbLd = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Data API benchmarks", item: `${SITE.url}/data-api` },
    ]),
  };

  const itemListLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Crypto data API benchmarks by OpenChainBench",
    description: DESCRIPTION,
    numberOfItems: BENCH_SLUGS.length,
    itemListElement: BENCH_SLUGS.map((slug, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: slug,
      url: `${SITE.url}/benchmarks/${slug}`,
    })),
  };

  return (
    <article
      className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16"
      style={{
        background:
          "linear-gradient(180deg, rgba(139,92,246,0.06), rgba(139,92,246,0) 320px)",
      }}
    >
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbLd) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListLd) }}
      />

      <header className="mb-8">
        <p className="label-mono text-violet-600 mb-2"
          style={{ fontFamily: "var(--font-mono, monospace)" }}>
          Data APIs
        </p>
        <h1 className="display text-4xl sm:text-5xl text-ink">
          Crypto data API benchmarks
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Nine independent benchmarks across five categories: price feed head
          lag, token metadata coverage, wallet indexing freshness, DEX network
          coverage, and NFT data quality. Every number is measured live from
          the same harness on the same schedule. No marketing claims, just probe
          data.
        </p>

        {/* Bench spec badges */}
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
          {BENCH_SLUGS.slice(0, 5).map((slug) => (
            <Link
              key={slug}
              href={`/benchmarks/${slug}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/8 px-3 py-1 hover:bg-violet-500/14 transition-colors"
            >
              <span
                className="label-mono text-ink-faint text-[10px]"
                style={{ fontFamily: "var(--font-mono, monospace)" }}
              >
                Bench
              </span>
              <span className="text-ink text-[11px]">{slug}</span>
            </Link>
          ))}
          {BENCH_SLUGS.length > 5 && (
            <span className="text-[11px] text-ink-faint">
              +{BENCH_SLUGS.length - 5} more
            </span>
          )}
        </div>
      </header>

      {snapshot ? (
        <>
          {/* KPI strip */}
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
            <KpiCard
              label="Providers benchmarked"
              value={String(snapshot.totals.uniqueProviders)}
              accent="#8b5cf6"
            />
            <KpiCard
              label="Active benchmarks"
              value={String(snapshot.totals.benchCount)}
            />
            <KpiCard
              label="Freshest price feed"
              value={
                snapshot.totals.headlinePriceFeed
                  ? `${snapshot.totals.headlinePriceFeed.name} · ${snapshot.totals.headlinePriceFeed.value}`
                  : "..."
              }
              tip="Best provider on aggregator-head-lag (p50 head lag, 24h, all chains & regions)."
              accent="#f59e0b"
            />
            <KpiCard
              label="Fastest wallet indexing"
              value={
                snapshot.totals.headlineIndexing
                  ? `${snapshot.totals.headlineIndexing.name} · ${snapshot.totals.headlineIndexing.value}`
                  : "..."
              }
              tip="Best provider on indexing-freshness: seconds from Base tx confirm to API visibility (p50, 24h)."
              accent="#10b981"
            />
          </section>

          {/* Group summary pills */}
          <div className="flex flex-wrap gap-2 mb-8">
            {snapshot.groups.map(({ group, benches }) => {
              const meta = GROUP_META[group];
              const leader = benches[0]?.leader;
              return (
                <div
                  key={group}
                  className="flex items-center gap-2 rounded-lg border border-ink/10 px-3 py-2 bg-paper-soft/40"
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: meta.accent }}
                  />
                  <span className="text-[12px] font-medium text-ink">{meta.shortLabel}</span>
                  {leader && (
                    <span className="text-[11px] text-ink-faint ml-1">
                      {leader.name}
                      {" "}
                      <span
                        className="label-mono font-semibold"
                        style={{ color: meta.accent, fontFamily: "var(--font-mono, monospace)" }}
                      >
                        {fmtDataValue(leader.p50, benches[0].unit)}
                      </span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <DataApiHubTabs snapshot={snapshot} />

          <p className="mt-6 text-[11px] text-ink-faint italic">
            All numbers are p50 values from the trailing 24h window unless noted.
            Click any bench title for the full leaderboard with p90/p99, per-region
            tabs, and time-series charts. Refresh interval 60s.
          </p>
        </>
      ) : (
        <WarmingUp />
      )}

      <footer className="mt-16 pt-6 border-t border-ink/10 text-[12px] text-ink-soft leading-relaxed">
        <p className="label-mono text-ink-faint mb-2"
          style={{ fontFamily: "var(--font-mono, monospace)" }}>
          Methodology
        </p>
        <p className="max-w-3xl">
          Each benchmark uses an independent probe harness with its own
          cadence and measurement axis. Price feed head lag captures
          millisecond-precision timestamps at the probe node and at each
          provider API, computing the wall-clock difference. Metadata and
          coverage benches hit provider endpoints with canonical test tokens
          or addresses, recording which fields are populated. Indexing
          freshness measures the gap between a Base block confirmation and
          the moment each wallet API returns the transaction. All harnesses
          are open source on{" "}
          <Link
            href="https://github.com/ChainBench/OpenChainBench"
            className="underline hover:text-ink"
            rel="noopener noreferrer"
            target="_blank"
          >
            GitHub
          </Link>
          . Data released under{" "}
          <Link
            href="https://creativecommons.org/licenses/by/4.0/"
            className="underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            CC BY 4.0
          </Link>
          .
        </p>
      </footer>
    </article>
  );
}

function KpiCard({
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
            className="inline-block w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: accent }}
          />
        )}
        {label}
      </p>
      <p className="text-base sm:text-xl font-semibold tabular-nums leading-tight text-ink">
        {value}
      </p>
    </div>
  );
}

function WarmingUp() {
  return (
    <section className="rounded-xl border border-ink/10 card-soft p-6 sm:p-8">
      <p
        className="label-mono text-[10px] text-ink-faint mb-2"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        Data warming up
      </p>
      <p className="text-sm text-ink-soft max-w-2xl leading-relaxed">
        The cross-bench snapshot has not yet been published. Individual
        benchmark pages are already live:
      </p>
      <ul className="mt-4 flex flex-wrap gap-2 text-[12.5px]">
        {BENCH_SLUGS.map((slug) => (
          <li key={slug}>
            <Link
              href={`/benchmarks/${slug}`}
              className="inline-flex rounded-full border border-ink/15 px-3 py-1 text-ink-soft hover:text-ink hover:border-ink/30 transition-colors"
            >
              {slug}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
