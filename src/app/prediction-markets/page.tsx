import Link from "next/link";
import { fetchPmCohort, type PmCohortSummary } from "@/lib/pm-stats";
import { AnswersForBench } from "@/components/answers-for-bench";
import { PmHubTabs } from "@/components/pm-hub-tabs";
import { pageMetadata } from "@/lib/page-metadata";
import {
  safeJsonLd,
  buildBreadcrumbJsonLd,
  buildFaqPageJsonLd,
} from "@/lib/jsonld";
import { SITE } from "@/data/site";
import {
  buildCitationMeta,
  CREATOR_PUBLISHER,
  DATASET_LICENSE,
} from "@/lib/dataset-jsonld";

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


const FALLBACK_DESCRIPTION =
  "Every tracked prediction market on one cross-venue leaderboard: open interest, 24h volume, turnover, resolution delay and API latency.";

// 57 characters. page-metadata ships hub titles without the brand
// suffix, so this is the full SERP string.
const TITLE = "Prediction market leaderboard 2026: open interest";

// Same numbers as the lede and the table, read from the same cohort.
// 158 characters at most: the SERP truncates beyond that.
function describe(cohort: PmCohortSummary | null): string {
  if (!cohort) return FALLBACK_DESCRIPTION;
  const lead = leaderByOi(cohort);
  const n = cohort.totals.trackedVenues;
  if (!lead || lead.openInterest == null) return FALLBACK_DESCRIPTION;
  return `${lead.name} leads ${n} prediction markets on open interest at ${fmtUSD(lead.openInterest)}. Open interest, volume, turnover and resolution delay, measured live.`;
}

// Highest open interest among venues that report one. Sorted here rather
// than relying on registry order, which puts Polymarket first whatever
// the numbers say.
function leaderByOi(cohort: PmCohortSummary) {
  return (
    [...cohort.venues]
      .filter((v) => v.openInterest != null)
      .sort((a, b) => (b.openInterest ?? -1) - (a.openInterest ?? -1))[0] ?? null
  );
}

export async function generateMetadata(): Promise<import("next").Metadata> {
  const cohort = await fetchPmCohort();
  return {
    ...pageMetadata({
      path: "/prediction-markets",
      title: TITLE,
      description: describe(cohort),
    }),
    other: buildCitationMeta({
      title: TITLE,
      url: `${SITE.url}/prediction-markets`,
      asOfIso: cohort ? new Date(cohort.asOf * 1000).toISOString() : null,
      jsonUrl: `${SITE.url}/api/stat/pm-open-interest`,
    }),
  };
}

export const revalidate = 3600;

export default async function PredictionMarketsHubPage() {
  const cohort = await fetchPmCohort();

  const lead = cohort ? leaderByOi(cohort) : null;
  const tracked = cohort?.totals.trackedVenues ?? 0;
  const asOfLabel = cohort
    ? `${new Date(cohort.asOf * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : null;
  // Widest turnover spread in the cohort: the one reading on this page
  // that no venue publishes about itself and no aggregator prints.
  // Ranked venues only, matching the bench's own $500k floor: below it a
  // single position moves a venue by tens of percent, and the FAQ was
  // quoting Myriad's $38.6k book as the cohort's turnover leader.
  const RANK_FLOOR_USD = 500_000;
  const byTurnover = (cohort?.venues ?? [])
    .filter(
      (v) =>
        v.turnover24h != null &&
        !v.playMoney &&
        v.openInterest != null &&
        v.openInterest >= RANK_FLOOR_USD,
    )
    .sort((a, b) => (b.turnover24h ?? 0) - (a.turnover24h ?? 0));
  const fastest = byTurnover[0] ?? null;
  const slowest = byTurnover[byTurnover.length - 1] ?? null;

  // Both legs from the same venues, or the ratio describes no one. The
  // cohort totals include venues that report only volume (Polymarket US)
  // or only open interest (Rain, Augur), so they cannot divide.
  const bothLegs = (cohort?.venues ?? []).filter(
    (v) => !v.playMoney && v.volume24h != null && v.openInterest != null && v.openInterest > 0,
  );
  const cohortTurnover = bothLegs.length
    ? bothLegs.reduce((t, v) => t + (v.volume24h ?? 0), 0) /
      bothLegs.reduce((t, v) => t + (v.openInterest ?? 0), 0)
    : null;
  const leadSentence =
    lead && lead.openInterest != null
      ? `${lead.name} holds ${fmtUSD(lead.openInterest)} of open interest, the largest of ${tracked} tracked venues.`
      : "";

  const faq = cohort
    ? [
        {
          q: "Which prediction market has the most open interest right now?",
          a:
            lead && lead.openInterest != null
              ? `${lead.name}, at ${fmtUSD(lead.openInterest)}. The table below ranks ${tracked} tracked venues by open interest as of ${asOfLabel}.`
              : "The leaderboard below ranks every tracked venue by open interest, read from each venue's public API or from the DefiLlama aggregate.",
        },
        {
          q: "What does turnover mean on this page?",
          a:
            fastest &&
            slowest &&
            fastest.turnover24h != null &&
            slowest.turnover24h != null &&
            fastest.slug !== slowest.slug
              ? `24-hour volume divided by open interest: how many times a venue's book turns over in a day. ${slowest.name} sits at ${fmtTurnover(slowest.turnover24h)} and ${fastest.name} at ${fmtTurnover(fastest.turnover24h)}. A low figure means capital parked on long-dated outcomes; a high one means short-dated markets on a thin book. Two different businesses under one category label.`
              : "24-hour volume divided by open interest: how many times a venue's book turns over in a day. A low figure means capital parked on long-dated outcomes, a high one means short-dated markets on a thin book.",
        },
        {
          q: "Where do the open interest and volume numbers come from?",
          a: "Open interest comes from the venue where the venue publishes a usable figure and from DefiLlama protocol TVL otherwise, and for open interest that is more often DefiLlama: Kalshi publishes it natively, while Polymarket's gamma field is deprecated and reads an order of magnitude low, so Polymarket and Limitless use TVL. Volume is each venue's own where its API gives one, otherwise DefiLlama. Where a venue's own read is a partial view the aggregate wins: unauthenticated, the harness can only sum Kalshi's event catalog and reaches $2.26M against DefiLlama's $424.8M for the same day, so Kalshi's volume is the aggregate's. Every row's tag names its own source.",
        },
        {
          q: "Why do some venues show no latency or resolution figure?",
          a: "Those columns come from separate probes (pm-api-latency, pm-resolution-delay, pm-ws-latency) which run against venues with a documented public API. A venue fed through the DefiLlama aggregate carries open interest and volume but no probe columns, and shows a dash rather than a zero.",
        },
        {
          q: "Can I cite these numbers?",
          a: "Yes. Every figure is reproducible from public sources, released under CC BY 4.0, and the bench pages expose machine-readable /api/stat endpoints with the same values and timestamp.",
        },
      ]
    : [];
  const faqLd = buildFaqPageJsonLd(
    faq,
    `${SITE.url}/prediction-markets`,
    null,
    "Prediction market leaderboard: frequently asked questions",
  );

  const datasetLd = cohort
    ? {
        "@context": "https://schema.org",
        "@type": "Dataset",
        "@id": `${SITE.url}/prediction-markets#dataset`,
        name: "Prediction market leaderboard: open interest, volume, turnover and resolution delay per venue",
        description: `Cross-venue prediction market measurements by OpenChainBench: open interest, 24-hour and 30-day volume, turnover, active markets, resolution delay and API latency for ${tracked} tracked venues, from public venue APIs and the DefiLlama aggregate.`,
        url: `${SITE.url}/prediction-markets`,
        license: DATASET_LICENSE,
        creator: CREATOR_PUBLISHER,
        publisher: CREATOR_PUBLISHER,
        isAccessibleForFree: true,
        dateModified: new Date(cohort.asOf * 1000).toISOString(),
        distribution: [
          {
            "@type": "DataDownload",
            encodingFormat: "application/json",
            contentUrl: `${SITE.url}/api/stat/pm-open-interest`,
          },
        ],
        variableMeasured: [
          { "@type": "PropertyValue", name: "Open interest", unitText: "USD" },
          { "@type": "PropertyValue", name: "Volume 24h", unitText: "USD" },
          { "@type": "PropertyValue", name: "Turnover, 24h volume over open interest" },
          { "@type": "PropertyValue", name: "Median resolution delay", unitText: "min" },
          { "@type": "PropertyValue", name: "p50 API latency", unitText: "ms" },
        ],
      }
    : null;

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
        // Ranked by the column the page sorts on, capped at 15 so the
        // SERP card does not churn when a venue at the tail drops a
        // series for one scrape.
        numberOfItems: Math.min(15, cohort.venues.filter((r) => r.benched).length),
        itemListElement: [...cohort.venues]
          .filter((r) => r.benched)
          .sort((a, b) => (b.openInterest ?? -1) - (a.openInterest ?? -1))
          .slice(0, 15)
          .map((r, i) => ({
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
      {datasetLd && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(datasetLd) }}
        />
      )}
      {itemListLd && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListLd) }}
        />
      )}
      {faqLd && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(faqLd) }}
        />
      )}

      <header className="mb-8">
        <p className="label-mono text-teal-600 mb-2">Prediction markets</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">
          Prediction market leaderboard: open interest, volume, turnover.
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          {leadSentence} Every venue ranks itself on the metric it picks.
          OCB picks the metrics, then ranks every venue on the same axis:
          open interest, turnover, resolution honesty, API latency.
        </p>
        {asOfLabel && (
          <p className="mt-2 text-xs text-ink-muted">
            Data as of{" "}
            <time dateTime={new Date(cohort!.asOf * 1000).toISOString()}>
              {asOfLabel}
            </time>
            , refreshed every five minutes.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
          <Link
            href="/benchmarks/pm-open-interest"
            className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Bench
            </span>
            <span className="text-ink">pm-open-interest</span>
          </Link>
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
            href="/benchmarks/pm-resolution-delay"
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
          <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
            <SummaryCard
              label="Total open interest"
              value={fmtUSD(cohort.totals.openInterest)}
              accent="#14b8a6"
              tip="Sum of per-venue open interest across every venue that reports one. Venues that report none are skipped, not counted as zero."
            />
            <SummaryCard
              label="Total volume 24h"
              value={fmtUSD(cohort.totals.volume24h)}
            />
            <SummaryCard
              label="Cohort turnover"
              value={fmtTurnover(cohortTurnover)}
              tip={`24h volume over open interest across the ${bothLegs.length} venues that publish both, so the ratio describes the same set on each side. Dominated by the two largest, which sit at opposite ends of the per-venue range.`}
            />
            <SummaryCard
              label="Active markets"
              value={fmtCount(cohort.totals.activeMarkets)}
              tip="Only the six venues with a native fetcher publish a market count; the aggregate-fed venues do not."
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
          </section>

          <h2 className="display text-2xl text-ink mt-10 mb-1">
            Every tracked venue, ranked by open interest
          </h2>
          <p className="text-sm text-ink-soft mb-3 max-w-2xl">
            {tracked} venues carry at least one live measurement. Sort any
            column; venues below the {fmtUSD(RANK_FLOOR_USD)} open-interest
            floor keep their figures but are not ranked.
          </p>
          <PmHubTabs cohort={cohort} />

          {/* The FAQPage JSON-LD above described questions that existed
              nowhere on the page. Structured data is meant to describe
              what a reader can see, so render the same list. */}
          {faq.length > 0 && (
            <section className="mt-12 max-w-3xl">
              <h2 className="display text-2xl text-ink mb-4">
                Questions about this leaderboard
              </h2>
              <dl className="space-y-4">
                {faq.map((f) => (
                  <div
                    key={f.q}
                    className="card-soft rounded-lg border border-ink/10 px-4 py-3"
                  >
                    <dt className="text-[15px] font-medium text-ink">{f.q}</dt>
                    <dd className="mt-1.5 text-sm text-ink-soft leading-relaxed">
                      {f.a}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {/* Goes through loadAllAnswers, which drops answers whose bench
              was removed from this deployment. The hand-written list this
              replaces linked three 404s, including one whose answer is
              still status:live but whose bench went in 2026-07. */}
          <AnswersForBench
            benchSlugs={[
              "pm-open-interest",
              "pm-api-latency",
              "pm-resolution-delay",
              "pm-ws-latency",
              "pm-rate-limits",
            ]}
            heading="Questions these benchmarks answer"
          />

          <p className="mt-4 text-[11px] text-ink-faint italic">
            Source:{" "}
            <Link
              href="https://github.com/ChainBench/upstream-monorepo/tree/dev/miniapps/pm-cohort-stats"
              className="underline hover:text-ink"
              rel="noopener noreferrer"
              target="_blank"
            >
              pm-cohort-stats harness
            </Link>{" "}
            (volume, OI, active markets, top market, markets &gt;$1M)
            plus the live PM bench fleet (api latency, resolution delay,
            ws latency). All gauges scraped from the public OCB Prom,
            Click a venue row above to open its
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
            href="/benchmarks/pm-resolution-delay"
            className="underline"
          >
            /benchmarks/pm-resolution-delay
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
        <h2 className="label-mono text-ink-faint mb-2">How OpenChainBench measures this</h2>
        <p>
          Venue rows aggregate the public APIs of each platform, normalized
          to USD and UTC days. Venues without a public API are read from
          the DefiLlama protocol and DEX aggregates, which is also how a
          venue too new to have documented endpoints enters the cohort.
          Turnover is 24h volume over open interest, computed only where
          both legs come from the same venue. Resolution delay comes from
          the pm-resolution-delay bench (anchor: ProposePrice for UMA
          backed markets). API latency is the 24h p50 of warm, non cached
          price requests from us-east, eu-west and Singapore.
        </p>
        <p className="mt-3">
          Two figures on this page disagree with a venue&rsquo;s own feed,
          and the disagreement is deliberate. Kalshi&rsquo;s
          unauthenticated trades endpoint reported $2.26M of 24h volume
          against the aggregate&rsquo;s $424.8M on 2026-09-23: the public
          slice is a partial view by construction, so the aggregate is
          published instead. Polymarket&rsquo;s gamma open interest field
          is deprecated and reads far below the protocol&rsquo;s tracked
          value, so open interest for Polymarket and Limitless is the
          DefiLlama protocol figure. Both substitutions are marked on the
          cell.
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

function fmtTurnover(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  // A book that turned over $681 against $837k of open interest did not
  // turn over none of it. Below the display floor, say so.
  if (v > 0 && v < 0.01) return "<0.01×";
  return v < 10 ? `${v.toFixed(2)}×` : `${v.toFixed(1)}×`;
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
