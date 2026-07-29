import Link from "next/link";
import { fetchPmCohort } from "@/lib/pm-stats";
import { PmHubTabs } from "@/components/pm-hub-tabs";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

/**
 * Hub landing page for the prediction markets cohort. SSR'd against
 * the `pm-cohort-stats` harness gauges plus the existing PM bench
 * gauges (pm-api-latency, pm-resolution-delay, pm-ws-latency). One
 * server fetch, sortable venue leaderboard below.
 *
 * The page positions OCB as the neutral cross venue measurement layer:
 * resolution honesty, API quality, WS latency, all on the same
 * timeline and with the same methodology. Per venue pages live on the
 * bench specs (`/benchmarks/pm-*`); cross venue context lives here.
 *
 * The hub renders gracefully before the harness goes live: every
 * numeric field is independently nullable, the leaderboard shows a row
 * of dashes for missing data, and the JSON-LD ItemList stays valid
 * because it lists venue identities, not metric values.
 */

const ANSWERS = [
  { slug: "how-long-does-polymarket-take-to-resolve", question: "How long does Polymarket take to resolve a market?" },
  { slug: "polymarket-vs-kalshi-resolution-speed", question: "Polymarket vs Kalshi, which resolves prediction markets faster?" },
  { slug: "which-prediction-market-data-api-is-the-freshest", question: "Which prediction market data API publishes the freshest Polymarket data?" },
  { slug: "which-prediction-market-has-the-strictest-rate-limits", question: "Which prediction market API has the strictest rate limits?" },
  { slug: "polymarket-fees-explained", question: "What fees does Polymarket charge?" },
  { slug: "polymarket-vs-kalshi-fees", question: "Polymarket vs Kalshi fees, which is cheaper to trade?" },
  { slug: "is-polymarket-safe", question: "Is Polymarket safe to use?" },
  { slug: "best-prediction-market-for-sports", question: "Which prediction market is best for sports?" },
  { slug: "best-prediction-market-for-politics", question: "Which prediction market is best for politics and elections?" },
  { slug: "manifold-markets-vs-polymarket", question: "Manifold Markets vs Polymarket, which should you use?" },
  { slug: "is-polymarket-legal-in-the-us", question: "Is Polymarket legal in the United States?" },
  { slug: "prediction-market-api-for-developers", question: "Which prediction market API is best for developers?" },
] as const;

const DESCRIPTION =
  "Polymarket vs Kalshi plus Limitless and Myriad on one cross-venue leaderboard: volume, open interest, resolution delay and API latency.";

export const metadata: import("next").Metadata = pageMetadata({
  path: "/prediction-markets",
  title: "Prediction markets leaderboard 2026",
  description: DESCRIPTION,
});

export const revalidate = 60;

export default async function PredictionMarketsHubPage() {
  const cohort = await fetchPmCohort();

  const breadcrumbLd = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Prediction markets", item: `${SITE.url}/prediction-markets` },
    ]),
  };

  // ItemList JSON-LD points at the bench pages for each venue rather
  // than a per venue product page, because OCB doesn't have one yet
  // (the bench pages are the canonical surface). Keeping this list
  // stable means the SERP card doesn't churn if the harness drops a
  // series momentarily.
  const itemListLd = cohort
    ? {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: "Prediction market venues tracked by OpenChainBench",
        description:
          "Prediction market venues tracked by OpenChainBench, with cross venue measurements of volume, resolution delay, API latency and data freshness.",
        numberOfItems: cohort.venues.length,
        itemListElement: cohort.venues.map((r, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: r.name,
          url: `${SITE.url}/products/${r.slug}`,
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
        <p className="label-mono text-teal-600 mb-2">Prediction markets</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">
          Prediction markets, measured neutrally.
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Every venue ranks itself on the metric it picks. OCB picks the
          metrics, then ranks every venue on the same axis: resolution
          honesty, API latency, data freshness. {DESCRIPTION}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
          <Link
            href="/benchmarks/pm-api-latency"
            className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Bench
            </span>
            <span className="text-ink">pm-api-latency</span>
          </Link>
          <Link
            href="/benchmarks/polymarket-resolution-delay"
            className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Bench
            </span>
            <span className="text-ink">pm-resolution-delay</span>
          </Link>
          <Link
            href="/benchmarks/pm-ws-latency"
            className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Bench
            </span>
            <span className="text-ink">pm-ws-latency</span>
          </Link>
          <Link
            href="/benchmarks/pm-rate-limits"
            className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Bench
            </span>
            <span className="text-ink">pm-rate-limits</span>
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
          <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
            <SummaryCard
              label="Total volume 30d"
              value={fmtUSD(cohort.totals.volume30d)}
              accent="#14b8a6"
            />
            <SummaryCard
              label="Active markets"
              value={fmtCount(cohort.totals.activeMarkets)}
            />
            <SummaryCard
              label="Cohort median resolution"
              value={fmtMinutes(cohort.totals.medianResolutionDelayMin)}
              tip="Median of per venue median resolution delays, across the trailing 30 days."
            />
            <SummaryCard
              label="Cohort p50 API latency"
              value={fmtMs(cohort.totals.p50ApiLatencyMs)}
              tip="Median of per venue p50 latency on the warm price endpoint, trailing 24h."
            />
            <SummaryCard
              label="Tracked venues"
              value={`${cohort.venues.length}${cohort.dataFeeds.length > 0 ? ` + ${cohort.dataFeeds.length}` : ""}`}
            />
          </section>

          <PmHubTabs cohort={cohort} />

          <section className="mt-10">
            <p className="label-mono text-teal-600 mb-3 text-[11px]" style={{ fontFamily: "var(--font-mono, monospace)" }}>
              Measured answers
            </p>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ANSWERS.map((a) => (
                <li key={a.slug}>
                  <Link
                    href={`/answers/${a.slug}`}
                    className="card-soft flex items-start gap-2 rounded-lg border border-ink/10 px-4 py-3 text-sm text-ink hover:border-teal-500/40 hover:bg-teal-500/5 transition-colors"
                  >
                    {a.question}
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <p className="mt-4 text-[11px] text-ink-faint italic">
            Source:{" "}
            <Link
              href="https://github.com/MobulaFi/mobula-monorepo/tree/dev/miniapps/pm-cohort-stats"
              className="underline hover:text-ink"
              rel="noopener noreferrer"
              target="_blank"
            >
              pm-cohort-stats harness
            </Link>{" "}
            (volume, OI, active markets, top market, markets &gt;$1M)
            plus the live PM bench fleet (api latency, resolution delay,
            ws latency). All gauges scraped from the public OCB Prom,
            refresh interval 60s. Click a venue row above to open its
            dedicated product page. Hover the dotted underline on any
            value to see how it is computed.
          </p>
        </>
      ) : (
        <p className="text-sm text-ink-faint italic">
          Cohort data is temporarily unavailable. The bench pages are
          still live at{" "}
          <Link href="/benchmarks/pm-api-latency" className="underline">
            /benchmarks/pm-api-latency
          </Link>
          ,{" "}
          <Link
            href="/benchmarks/polymarket-resolution-delay"
            className="underline"
          >
            /benchmarks/polymarket-resolution-delay
          </Link>
          ,{" "}
          <Link href="/benchmarks/pm-ws-latency" className="underline">
            /benchmarks/pm-ws-latency
          </Link>{" "}
          and{" "}
          <Link href="/benchmarks/pm-rate-limits" className="underline">
            /benchmarks/pm-rate-limits
          </Link>
          .
        </p>
      )}

      <footer className="mt-16 pt-6 border-t border-ink/10 text-[12px] text-ink-soft leading-relaxed">
        <p className="label-mono text-ink-faint mb-2">Methodology</p>
        <p>
          Venue rows aggregate the public APIs of each platform, normalized
          to USD and UTC days. Resolution delay comes from the
          pm-resolution-delay bench (anchor: ProposePrice for UMA backed
          markets). API latency is the 24h p50 of warm, non cached price
          requests from us-east, eu-west and Singapore. Freshness compares
          third party relays against the Polymarket CLOB T0 stream.
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

function fmtCount(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}

function fmtMinutes(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v < 60) return `${v.toFixed(1)}m`;
  const h = v / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function fmtMs(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v < 1) return `${(v * 1000).toFixed(0)}us`;
  if (v < 1000) return `${v.toFixed(0)}ms`;
  return `${(v / 1000).toFixed(2)}s`;
}
