import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd, buildFaqPageJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { CREATOR_PUBLISHER, DATASET_LICENSE } from "@/lib/dataset-jsonld";
import { AnswersForBench } from "@/components/answers-for-bench";
import {
  PERP_ASSETS,
  fetchPerpAssetPage,
  perpAssetBySlug,
  sortPerpAssetRows,
  type PerpAssetVenueRow,
} from "@/lib/perp-asset-pages";

/**
 * /perps/eth, /perps/btc, /perps/sol: one underlying, every venue's
 * measured opening cost, slippage, taker fee and funding over 24h, 7d
 * and 30d, with the CEX funding reference underneath. The cohort hub
 * ranks venues; these pages answer the question a trader actually has
 * ("where is ETH cheapest to trade and hold right now") on the asset
 * they trade. Data comes from the worker-written snapshot the hub also
 * reads (perp-asset-pages), itself built from the perp-fees and
 * perp-cohort-stats series.
 */

export const revalidate = 3600;

export function generateStaticParams() {
  return PERP_ASSETS.map((a) => ({ asset: a.slug }));
}

const fmtBps = (v: number | null): string => {
  if (v == null || !Number.isFinite(v)) return "–";
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `${v < 0 ? "−" : ""}${abs.toFixed(digits)} bps`;
};

const fmtSignedBps = (v: number | null): string => {
  if (v == null || !Number.isFinite(v)) return "–";
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(Math.abs(v) >= 100 ? 0 : 1)} bps`;
};

/** A month of hourly samples behind the 30d column. A venue is named as
 *  the cheapest to hold over 30 days only with (nearly) the whole month
 *  measured; a shorter window is shown with its day count. */
const MONTH_OF_HOURS = 720;
// Harness restarts leave hour-sized gaps in a month (628 of 720 hours
// answered on 2026-09-22), so a full month is 80 % of the grid.
const FULL_MONTH_MIN = MONTH_OF_HOURS * 0.8;
const daysMeasured = (samples: number | null): number => Math.round(((samples ?? 0) / 24) * 10) / 10;

function cheapest<K extends keyof PerpAssetVenueRow>(rows: PerpAssetVenueRow[], key: K): PerpAssetVenueRow | null {
  const withValue = rows.filter((r) => typeof r[key] === "number");
  if (withValue.length === 0) return null;
  return withValue.reduce((best, r) => ((r[key] as number) < (best[key] as number) ? r : best));
}

export async function generateMetadata({ params }: { params: Promise<{ asset: string }> }): Promise<Metadata> {
  const { asset: slug } = await params;
  const a = perpAssetBySlug(slug);
  if (!a) return {};
  const page = await fetchPerpAssetPage(a.asset);
  const rows = page ? sortPerpAssetRows(page.data.venues) : [];
  const fee = cheapest(rows, "allInBps");
  // Same rule as the page: only a venue with (nearly) the whole month
  // measured is named the cheapest to hold over 30 days.
  const fund = cheapest(rows.filter((r) => (r.funding30dSamples ?? 0) >= FULL_MONTH_MIN), "funding30dBps");
  const description = fee
    ? `${fee.name} opens a $1k ${a.asset} long at ${fmtBps(fee.allInBps)} all in${fund ? `, ${fund.name} was cheapest to hold over 30 days at ${fmtSignedBps(fund.funding30dBps)}` : ""}. ${rows.length} venues, fees, slippage and funding measured live.`
    : `${a.asset} perps compared across venues: all-in opening cost, $100k slippage, taker fee and funding over 24h, 7d and 30d, measured live from public APIs.`;
  return pageMetadata({
    path: `/perps/${a.slug}`,
    title: `${a.asset} perps: cheapest venue to trade and hold, live`,
    description,
  });
}

function Cell({ v, signed = false }: { v: number | null; signed?: boolean }) {
  return (
    <td className="num mono tabular-nums px-2 py-1.5 text-right whitespace-nowrap">{signed ? fmtSignedBps(v) : fmtBps(v)}</td>
  );
}

function VenueTable({ list, showFees }: { list: PerpAssetVenueRow[]; showFees: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-ink/10">
            <th className="px-2 py-1.5">Venue</th>
            {showFees && (
              <>
                <th className="px-2 py-1.5 text-right">All-in $1k</th>
                <th className="px-2 py-1.5 text-right">Slippage $100k</th>
                <th className="px-2 py-1.5 text-right">Taker</th>
              </>
            )}
            <th className="px-2 py-1.5 text-right">Funding 24h</th>
            <th className="px-2 py-1.5 text-right">Funding 7d</th>
            <th className="px-2 py-1.5 text-right">Funding 30d</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => {
            const partial = r.funding30dBps != null && (r.funding30dSamples ?? 0) < FULL_MONTH_MIN;
            return (
              <tr key={r.slug} className="border-b border-ink/5">
                <td className="px-2 py-1.5">
                  {r.venueType === "cex" ? (
                    <span className="text-ink">{r.name}</span>
                  ) : (
                    <Link href={`/products/${r.productSlug}#perp`} className="text-ink underline-offset-2 hover:underline">
                      {r.name}
                    </Link>
                  )}
                  {r.venueType === "regulated" && <span className="ml-1.5 text-[10px] text-ink-faint uppercase">regulated</span>}
                </td>
                {showFees && (
                  <>
                    <Cell v={r.allInBps} />
                    <Cell v={r.slippage100kBps} />
                    <Cell v={r.takerFeeBps} />
                  </>
                )}
                <Cell v={r.funding24hBps} signed />
                <Cell v={r.funding7dBps} signed />
                <td className="num mono tabular-nums px-2 py-1.5 text-right whitespace-nowrap">
                  {fmtSignedBps(r.funding30dBps)}
                  {partial && (
                    <span className="ml-1 text-[10px] text-ink-faint" title="Funding accumulated over the days measured, not a full month: the venue joined the cohort recently">
                      {daysMeasured(r.funding30dSamples)} d
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function PerpAssetPage({ params }: { params: Promise<{ asset: string }> }) {
  const { asset: slug } = await params;
  const a = perpAssetBySlug(slug);
  if (!a) notFound();

  const page = await fetchPerpAssetPage(a.asset);
  const rows = page ? sortPerpAssetRows(page.data.venues) : [];
  const cex = page ? sortPerpAssetRows(page.data.cex) : [];
  const fee = cheapest(rows, "allInBps");
  const slip = cheapest(rows, "slippage100kBps");
  const fund30 = cheapest(rows.filter((r) => (r.funding30dSamples ?? 0) >= FULL_MONTH_MIN), "funding30dBps");
  const asOfIso = page ? new Date(page.asOf * 1000).toISOString() : null;
  const asOfLabel = asOfIso ? asOfIso.slice(0, 16).replace("T", " ") + " UTC" : null;
  const pageUrl = `${SITE.url}/perps/${a.slug}`;
  const others = PERP_ASSETS.filter((x) => x.slug !== a.slug);

  const lead = fee
    ? `${fee.name} is the cheapest venue to open a $1,000 ${a.asset} long right now at ${fmtBps(fee.allInBps)} all in (taker fee plus half spread plus impact, 24h average)${slip ? `; ${slip.name} fills a $100,000 ${a.asset} market order with the least slippage at ${fmtBps(slip.slippage100kBps)}` : ""}${fund30 ? `; over the trailing 30 days ${fund30.name} was the cheapest venue to hold an ${a.asset} long, ${fmtSignedBps(fund30.funding30dBps)} of funding` : ""}.`
    : `Live ${a.asset} perp data is temporarily unavailable; the per-venue benchmarks below still carry the last measurements.`;

  const faq = [
    {
      q: `Which perp DEX is cheapest to trade ${a.asset} right now?`,
      a: fee
        ? `${fee.name}, at ${fmtBps(fee.allInBps)} all in for a $1,000 market long (taker fee ${fmtBps(fee.takerFeeBps)} plus half spread and impact), averaged over the last 24 hours across ${rows.filter((r) => r.allInBps != null).length} venues the perp-fees harness walks every 30 seconds.`
        : `The perp-fees benchmark ranks it live; the figure was unavailable when this page rendered.`,
    },
    {
      q: `Where does a $100k ${a.asset} market order slip the least?`,
      a: slip
        ? `${slip.name}, at ${fmtBps(slip.slippage100kBps)} of half spread plus impact with the fee excluded, walked on the venue's public order book every 30 seconds (perp-execution-quality benchmark). Venues whose book filled $100k on fewer than 90 percent of the ticks are not shown in that column, and oracle-priced venues (GMX v2, Gains) have no book to walk.`
        : `The perp-execution-quality benchmark ranks it live.`,
    },
    {
      q: `Which venue was cheapest to hold an ${a.asset} long over the last 30 days?`,
      a: fund30
        ? `${fund30.name}, at ${fmtSignedBps(fund30.funding30dBps)} of funding accumulated over the trailing 30 days (positive means the long paid). Venues measured for less than the whole month show the days behind their figure and are not counted for this answer.`
        : `The perp-funding-cost-30d benchmark ranks it once a month of samples exists.`,
    },
    {
      q: "How is funding over 7 and 30 days computed?",
      a: "The cohort harness records every minute each venue's current funding rate normalised to the cost of holding a long for 24 hours. The 7d and 30d columns average that series on an hourly grid and multiply by the days actually measured in the window (capped at 7 and 30): the funding a long held over those days paid, in basis points of notional. A venue that joined recently shows its day count next to the figure.",
    },
    {
      q: "Why are Binance, Bybit and OKX listed under the DEXs?",
      a: "As the funding reference. A carry trader compares a DEX against the large CEX books; their funding rows come from the same Mobula feed the perp-funding benchmark uses. Fees and slippage are not measured on CEXs here.",
    },
  ];

  // Without data the page says so in the body; it must not also ship a
  // Dataset and FAQ answers that read "unavailable" into the crawl for
  // the hour the render is cached.
  const breadcrumb = buildBreadcrumbJsonLd([
    { name: "Home", item: SITE.url },
    { name: "Perp DEX leaderboard", item: `${SITE.url}/perps` },
    { name: `${a.asset} perps`, item: pageUrl },
  ]);
  const jsonLd = rows.length === 0 ? { "@context": "https://schema.org", "@graph": [breadcrumb] } : {
    "@context": "https://schema.org",
    "@graph": [
      breadcrumb,
      {
        "@type": "Dataset",
        "@id": `${pageUrl}#dataset`,
        name: `${a.asset} perpetuals across venues: all-in cost, slippage, taker fee and funding`,
        description: `Per-venue ${a.asset} perp measurements: all-in cost to open a $1k long, slippage of a $100k market order, taker fee, and funding cost over 24h, 7d and 30d. Measured from public APIs by OpenChainBench.`,
        url: pageUrl,
        license: DATASET_LICENSE,
        creator: CREATOR_PUBLISHER,
        publisher: CREATOR_PUBLISHER,
        isAccessibleForFree: true,
        ...(asOfIso ? { dateModified: asOfIso } : {}),
        variableMeasured: [
          { "@type": "PropertyValue", name: "All-in opening cost, $1k long", unitText: "bps" },
          { "@type": "PropertyValue", name: "Slippage, $100k market order", unitText: "bps" },
          { "@type": "PropertyValue", name: "Taker fee", unitText: "bps" },
          { "@type": "PropertyValue", name: "Funding paid to hold a long, 24h / 7d / 30d", unitText: "bps" },
        ],
      },
      buildFaqPageJsonLd(faq, pageUrl),
    ],
  };

  return (
    <article className="mx-auto max-w-5xl px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      <nav aria-label="Breadcrumb" className="text-[12px] text-ink-faint mb-4">
        <Link href="/perps" className="hover:text-ink">Perp DEX leaderboard</Link>
        <span className="mx-1.5">/</span>
        <span className="text-ink-soft">{a.asset} perps</span>
      </nav>
      <header className="mb-8">
        <p className="label-mono text-teal-600 mb-2">Perpetuals by asset</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">
          {a.asset} perps: cheapest venue to trade and hold, live
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">{lead}</p>
        {asOfLabel && (
          <p className="mt-2 text-xs text-ink-muted">
            Data as of <time dateTime={asOfIso!}>{asOfLabel}</time>, refreshed every minute by the harnesses.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
          {others.map((o) => (
            <Link key={o.slug} href={`/perps/${o.slug}`} className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 px-3 py-1 text-ink-soft hover:text-ink">
              {o.asset} perps
            </Link>
          ))}
          {[
            { href: `/benchmarks/perp-fees?chain=${a.asset}`, label: "perp-fees" },
            { href: `/benchmarks/perp-execution-quality?chain=${a.asset}`, label: "perp-execution-quality" },
            { href: "/benchmarks/perp-funding", label: "perp-funding" },
            { href: "/benchmarks/perp-funding-cost-30d", label: "perp-funding-cost-30d" },
          ].map((b) => (
            <Link key={b.href} href={b.href} className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15">
              <span className="label-mono text-ink-faint text-[10px]" style={{ fontFamily: "var(--font-mono, monospace)" }}>Bench</span>
              <span className="text-ink">{b.label}</span>
            </Link>
          ))}
        </div>
      </header>

      {rows.length > 0 ? (
        <>
          <h2 className="display text-xl sm:text-2xl text-ink mb-3">{rows.length} venues listing {a.asset} perps</h2>
          <p className="text-sm text-ink-soft mb-3 max-w-3xl">
            All-in cost is the taker fee plus half spread plus impact of a $1,000 market long, 24h average (perp-fees). Slippage is the same walk at $100,000 with the fee removed (perp-execution-quality), shown only where the book filled $100k on at least 90 percent of the ticks; oracle-priced venues have no book and no slippage column. Funding is the cost of holding a long: at the current rate for 24h, and accumulated over the days measured in the trailing 7 and 30 (a day count marks a venue measured for less than the full window); positive means the long paid.
          </p>
          <VenueTable list={rows} showFees />
          {cex.length > 0 && (
            <>
              <h2 className="display text-lg sm:text-xl text-ink mt-10 mb-3">CEX funding reference</h2>
              <p className="text-sm text-ink-soft mb-3 max-w-3xl">
                The same {a.asset} funding cost on the large centralised books, from the Mobula funding feed. Fees and slippage are not measured on CEXs.
              </p>
              <VenueTable list={cex} showFees={false} />
            </>
          )}
        </>
      ) : (
        <p className="text-sm text-ink-faint italic">
          Per-asset data is temporarily unavailable. The bench pages are still live at{" "}
          <Link href="/benchmarks/perp-fees" className="underline">/benchmarks/perp-fees</Link> and{" "}
          <Link href="/benchmarks/perp-funding" className="underline">/benchmarks/perp-funding</Link>.
        </p>
      )}

      <section className="mt-12 max-w-3xl">
        <h2 className="display text-xl sm:text-2xl text-ink mb-4">Frequently asked</h2>
        <dl className="space-y-4">
          {faq.map((f) => (
            <div key={f.q}>
              <dt className="font-medium text-ink">{f.q}</dt>
              <dd className="mt-1 text-sm text-ink-soft leading-relaxed">{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <AnswersForBench
        benchSlugs={["perp-fees", "perp-execution-quality", "perp-funding", "perp-funding-cost-30d", "perp-cost-slope"]}
        heading="Questions these benchmarks answer"
      />

      <footer className="mt-16 pt-6 border-t border-ink/10 text-[12px] text-ink-soft leading-relaxed">
        <h2 className="label-mono text-ink-faint mb-2">How OpenChainBench measures</h2>
        <p>
          Fees and slippage: the perp-fees harness walks each venue&apos;s public order book for {a.asset} every 30 seconds at $1k, $10k, $100k and $1M and publishes the all-in cost per tier; this page shows the 24h averages. Funding: the perp-cohort-stats harness reads each venue&apos;s quoted rate every minute, normalises it to a 24h hold, and the 7d and 30d columns integrate that series. Sources are public and unauthenticated; the methodology is on each bench page.
        </p>
      </footer>
    </article>
  );
}
