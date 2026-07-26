import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  fetchHlBuilderStats,
  fetchHlCohort,
  fetchHlHistory,
  isHlBuilderSlug,
  type HlCohortRow,
  type HlHistoryFrontendCompact,
} from "@/lib/hl-builder-stats";
import { Breadcrumb } from "@/components/breadcrumb";
import { HlBuilderDashboard } from "@/components/hl-builder-dashboard";
import { ProviderLogo } from "@/components/provider-logo";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/jsonld";

/**
 * Per-frontend detail page for the Hyperliquid grid overview. Server
 * component rendering:
 *   - hero: name + current fees_30d + first-day / peak-fees badges
 *   - rich `HlBuilderDashboard`: HyperTracker-parity KPI grid, 30d
 *     performance chart with biggest-day marker, coin-share donut,
 *     user-percentile bar, milestone cards, top-users leaderboard.
 *     Ported from the legacy `/products/<hl-slug>` surface after the
 *     301 redirect so nothing is lost on the canonical URL.
 *   - peer group: 5 frontends of similar current-fees magnitude, each a
 *     link back to its own detail page
 *
 * When Prom is unreachable (`hlStats === null`), the dashboard is
 * skipped and the page falls back to the minimal 4-card KPI strip so
 * the surface still renders something useful.
 *
 * `generateStaticParams` returns every slug the history blob knows about
 * so the page routes are pre-listed at build (dynamicParams stays true,
 * so unknown-but-valid slugs still ISR).
 *
 * Unknown slugs 404 rather than rendering an empty shell.
 */

export const revalidate = 3600;
export const dynamicParams = true;

type Params = { slug: string };

export async function generateStaticParams(): Promise<Params[]> {
  const history = await fetchHlHistory();
  if (!history) return [];
  return history.frontends.map((f) => ({ slug: f.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const history = await fetchHlHistory();
  const frontend = history?.frontends.find((f) => f.slug === slug);
  // Fallback title uses a title-cased slug so a tracked builder without
  // a fresh history entry still ships a meaningful <title> (the page
  // falls back to a placeholder render below when frontend is missing,
  // matching this 200 metadata).
  const displayName = frontend?.name ?? titleCaseSlug(slug);
  if (!frontend) {
    return pageMetadata({
      path: `/hyperliquid/${slug}`,
      title: `${displayName}, Hyperliquid frontend`,
      description: `${displayName} on Hyperliquid: 12-month builder fees, volume and first-active date. Rolling 30-day metrics refresh as data becomes available.`,
    });
  }
  const currentFees = lastNonNull(frontend.fees);
  const peakFees = peakOf(frontend.fees);
  const description = `${frontend.name} on Hyperliquid: ${fmtUSDShort(
    currentFees,
  )} rolling 30-day builder fees (all-time peak ${fmtUSDShort(
    peakFees,
  )}). 12-month history with volume, fees and first-active date.`;
  return pageMetadata({
    path: `/hyperliquid/${slug}`,
    title: `${displayName}, Hyperliquid frontend`,
    description,
  });
}

export default async function HlFrontendPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const [history, cohort, hlStats] = await Promise.all([
    fetchHlHistory(),
    fetchHlCohort(),
    fetchHlBuilderStats(slug),
  ]);
  // Data-outage guard: this page is the target of PERMANENT redirects
  // from /products/<slug>, so it must never 404 on a runtime data gap
  // (stale KV snapshot, Prom unreachable). Tracked builders without a
  // resolvable history render a lightweight placeholder with HTTP 200
  // instead of the previous 307 bounce to /hyperliquid. Ahrefs was
  // flagging sitemap-listed builder URLs as 3xx-in-sitemap during the
  // brief windows where the history blob dropped their entries; a 200
  // placeholder keeps the URL crawlable while data catches up. Any
  // partial data we still have (cohort row from the KPI grid) surfaces
  // in the placeholder so the page isn't a soft 404. Unknown slugs
  // still 404.
  const frontend = history?.frontends.find((f) => f.slug === slug);
  if (!history || !frontend) {
    if (!(await isHlBuilderSlug(slug))) notFound();
    const cohortRow = cohort?.rows.find((r) => r.slug === slug);
    return <HlBuilderPending slug={slug} cohortRow={cohortRow} />;
  }

  const cohortRow = cohort?.rows.find((r) => r.slug === slug);
  const currentFees = cohortRow?.revenue30d ?? lastNonNull(frontend.fees);
  const currentVolume = cohortRow?.volume30d ?? lastNonNull(frontend.volume);
  const peakFees = peakOf(frontend.fees);
  const firstDayMs = history.t0 + history.step * 1000 * frontend.firstIdx;
  const firstDay = formatFullDate(firstDayMs);

  const peers = pickPeers(history.frontends, frontend, 5);

  const pageUrl = `https://openchainbench.com/hyperliquid/${slug}`;
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
      {
        "@type": "ListItem",
        position: 3,
        name: frontend.name,
        item: pageUrl,
      },
    ],
  };

  // Content-shape schema. Previously only BreadcrumbList was emitted,
  // which GSC treats as "no structured data for the primary content"
  // on data-heavy pages (frontend revenue + volume timeseries). Add a
  // Dataset node so Google Dataset Search + LLM crawlers index the
  // 30-day revenue/volume figures as a citable measurement rather than
  // treating the page as generic prose.
  const datasetLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${pageUrl}#dataset`,
    name: `${frontend.name}, HyperLiquid frontend revenue + volume`,
    description: `Daily HyperLiquid frontend fees and volume for ${frontend.name}, sourced from the OpenChainBench hyperliquid-frontends benchmark. First measured ${firstDay}.`,
    url: pageUrl,
    identifier: slug,
    creator: {
      "@type": "Organization",
      "@id": "https://openchainbench.com/#org",
      name: "OpenChainBench",
      url: "https://openchainbench.com",
    },
    publisher: {
      "@type": "Organization",
      "@id": "https://openchainbench.com/#org",
      name: "OpenChainBench",
      url: "https://openchainbench.com",
    },
    isAccessibleForFree: true,
    license: "https://creativecommons.org/licenses/by/4.0/",
    variableMeasured: [
      "HyperLiquid frontend fees (30d)",
      "HyperLiquid frontend volume (30d)",
    ],
    temporalCoverage: `${new Date(firstDayMs).toISOString().slice(0, 10)}/..`,
    distribution: [
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: "https://openchainbench.com/api/stat/hyperliquid-frontends",
      },
    ],
  };

  return (
    <article className="mx-auto max-w-[1200px] px-4 sm:px-6 py-12 sm:py-16">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbLd) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(datasetLd) }}
      />

      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          { label: "Hyperliquid", href: "/hyperliquid" },
          { label: frontend.name },
        ]}
      />

      <header className="mb-8">
        <p className="label-mono text-ink-faint mb-2">Hyperliquid frontend</p>
        <div className="flex items-center gap-4">
          <ProviderLogo slug={slug} name={frontend.name} size={56} />
          <h1 className="display text-4xl sm:text-5xl text-ink">
            {frontend.name}
          </h1>
        </div>
        <p
          className="mt-2 text-[12px] text-ink-faint"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {slug}
        </p>
        <div className="mt-4 flex items-baseline gap-3">
          <span className="text-4xl font-semibold tabular-nums text-ink">
            {fmtUSDShort(currentFees)}
          </span>
          <span className="text-sm text-ink-soft">rolling 30d builder fees</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-faint">
          <span>
            First day active:{" "}
            <span className="text-ink-soft">{firstDay}</span>
          </span>
          <span>
            Peak fees (30d):{" "}
            <span className="text-ink-soft tabular-nums">
              {fmtUSDShort(peakFees)}
            </span>
          </span>
        </div>
      </header>

      {hlStats ? (
        <HlBuilderDashboard stats={hlStats} name={frontend.name} />
      ) : (
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-10">
          <Kpi label="Fees 30d" value={fmtUSDShort(currentFees)} />
          <Kpi label="Volume 30d" value={fmtUSDShort(currentVolume)} />
          <Kpi label="First day active" value={firstDay} />
          <Kpi label="Peak fees (all-time 30d)" value={fmtUSDShort(peakFees)} />
        </section>
      )}

      {peers.length > 0 && (
        <section>
          <h2 className="text-2xl font-semibold mb-3">Peer group</h2>
          <p className="text-sm text-ink-soft mb-4 max-w-2xl">
            Frontends in the same order-of-magnitude bracket for current
            30-day fees.
          </p>
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {peers.map((p) => {
              const peerFees = lastNonNull(p.fees);
              return (
                <li key={p.slug}>
                  <Link
                    href={`/hyperliquid/${p.slug}`}
                    className="flex flex-col rounded-lg border border-ink/10 bg-paper p-3 hover:border-ink/30 hover:bg-paper-soft/40"
                  >
                    <span className="truncate text-sm font-semibold text-ink">
                      {p.name}
                    </span>
                    <span className="mt-1 text-base font-semibold tabular-nums text-ink">
                      {fmtUSDShort(peerFees)}
                    </span>
                    <span
                      className="mt-0.5 text-[10px] text-ink-faint"
                      style={{ fontFamily: "var(--font-mono, monospace)" }}
                    >
                      Fees 30d
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <p className="mt-10 text-[11px] text-ink-faint italic">
        Source: local hl node tailing every Hyperliquid mainnet fill. This
        page reads the same rolling-30d gauges as the /hyperliquid hub;
        data refreshes hourly on the ISR cache.
      </p>
    </article>
  );
}

/** Title-case a slug ("mass-dot-money" → "Mass Dot Money"). Used as the
 *  display fallback for a tracked builder whose 12-month history entry
 *  hasn't materialised yet. */
function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/** Lightweight placeholder rendered with HTTP 200 when a builder is in
 *  the spec catalog but temporarily absent from the history blob. Shows
 *  whatever cohort data is still resolvable so the page carries real
 *  content instead of a soft-404 shell. */
function HlBuilderPending({
  slug,
  cohortRow,
}: {
  slug: string;
  cohortRow: HlCohortRow | undefined;
}) {
  const name = cohortRow?.name ?? titleCaseSlug(slug);
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
      {
        "@type": "ListItem",
        position: 3,
        name,
        item: `https://openchainbench.com/hyperliquid/${slug}`,
      },
    ],
  };
  return (
    <article className="mx-auto max-w-[1200px] px-4 sm:px-6 py-12 sm:py-16">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbLd) }}
      />
      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          { label: "Hyperliquid", href: "/hyperliquid" },
          { label: name },
        ]}
      />
      <header className="mb-8">
        <p className="label-mono text-ink-faint mb-2">Hyperliquid frontend</p>
        <div className="flex items-center gap-4">
          <ProviderLogo slug={slug} name={name} size={56} />
          <h1 className="display text-4xl sm:text-5xl text-ink">{name}</h1>
        </div>
        <p
          className="mt-2 text-[12px] text-ink-faint"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {slug}
        </p>
      </header>
      {cohortRow ? (
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-10">
          <Kpi label="Fees 30d" value={fmtUSDShort(cohortRow.revenue30d)} />
          <Kpi label="Volume 30d" value={fmtUSDShort(cohortRow.volume30d)} />
          <Kpi label="Users 30d" value={cohortRow.users30d.toLocaleString()} />
          <Kpi
            label="Cohort share 24h"
            value={`${(cohortRow.cohortVolumeShare24h * 100).toFixed(2)}%`}
          />
        </section>
      ) : null}
      <section className="rounded-lg border border-ink/10 bg-paper-soft/40 p-5 max-w-2xl">
        <h2 className="text-lg font-semibold text-ink mb-2">
          12-month history aggregating
        </h2>
        <p className="text-sm text-ink-soft">
          {name} is tracked on the Hyperliquid builder cohort. The full
          12-month history chart, peer group and detailed KPIs will appear
          here as soon as the next data sweep completes. In the meantime,
          browse the{" "}
          <Link href="/hyperliquid" className="underline hover:no-underline">
            Hyperliquid frontends grid
          </Link>{" "}
          for live rankings.
        </p>
      </section>
    </article>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ink/10 bg-paper p-4">
      <p
        className="label-mono text-[10px] text-ink-faint"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {label}
      </p>
      <p className="mt-1.5 text-lg font-semibold tabular-nums text-ink">
        {value}
      </p>
    </div>
  );
}

function lastNonNull(arr: (number | null)[]): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return 0;
}

function peakOf(arr: (number | null)[]): number {
  let m = 0;
  for (const v of arr) {
    if (v !== null && v > m) m = v;
  }
  return m;
}

/** Pick up to `count` peers that sit in the same order-of-magnitude
 *  bracket as `me`. Excludes `me` itself and sorts by absolute proximity
 *  in log space, then by name for stability. */
function pickPeers(
  all: HlHistoryFrontendCompact[],
  me: HlHistoryFrontendCompact,
  count: number,
): HlHistoryFrontendCompact[] {
  const myFees = lastNonNull(me.fees);
  if (myFees <= 0) return [];
  const myLog = Math.log10(myFees);
  const scored = all
    .filter((f) => f.slug !== me.slug)
    .map((f) => {
      const v = lastNonNull(f.fees);
      if (v <= 0) return null;
      return { f, dist: Math.abs(Math.log10(v) - myLog) };
    })
    .filter((x): x is { f: HlHistoryFrontendCompact; dist: number } => x !== null);
  scored.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    return a.f.name.localeCompare(b.f.name);
  });
  return scored.slice(0, count).map((x) => x.f);
}

function fmtUSDShort(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatFullDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS_FULL[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
