import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd, buildFaqPageJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { buildCitationMeta, CREATOR_PUBLISHER, DATASET_LICENSE } from "@/lib/dataset-jsonld";
import { perpHeadToHead } from "@/lib/perp-head-to-head";
import { PERP_VENUE_META } from "@/lib/perp-venue-context";
import { AnswersForBench } from "@/components/answers-for-bench";
import { ProviderLogo } from "@/components/provider-logo";
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

// "not measured", never a dash: a model reading the table must not take
// a missing funding sample for zero.
const NOT_MEASURED = "not measured";

const fmtBps = (v: number | null): string => {
  if (v == null || !Number.isFinite(v)) return NOT_MEASURED;
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `${v < 0 ? "−" : ""}${abs.toFixed(digits)} bps`;
};

const fmtSignedBps = (v: number | null): string => {
  if (v == null || !Number.isFinite(v)) return NOT_MEASURED;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(Math.abs(v) >= 100 ? 0 : 1)} bps`;
};

/** A month of hourly samples behind the 30d column. The 30d figure is a
 *  month at the average daily cost of the hours measured; a venue is named
 *  as the cheapest to hold over 30 days only with (nearly) the whole month
 *  behind that average, and a shorter window is shown with its day count. */
const MONTH_OF_HOURS = 720;
// Harness restarts leave hour-sized gaps in a month (628 of 720 hours
// answered on 2026-09-22), so a full month is 80 % of the grid.
const FULL_MONTH_MIN = MONTH_OF_HOURS * 0.8;
const daysMeasured = (samples: number | null): number => Math.round(((samples ?? 0) / 24) * 10) / 10;

type NumKey = "allInBps" | "takerFeeBps" | "slippage100kBps" | "funding24hBps" | "funding7dBps" | "funding30dBps";

function cheapest(rows: PerpAssetVenueRow[], key: NumKey): PerpAssetVenueRow | null {
  const withValue = rows.filter((r) => typeof r[key] === "number");
  if (withValue.length === 0) return null;
  return withValue.reduce((best, r) => ((r[key] as number) < (best[key] as number) ? r : best));
}

const countWith = (rows: PerpAssetVenueRow[], key: NumKey) => rows.filter((r) => typeof r[key] === "number").length;

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
  const title = `${a.asset} perps: cheapest venue to trade and hold, live`;
  return {
    ...pageMetadata({ path: `/perps/${a.slug}`, title, description }),
    other: buildCitationMeta({
      title,
      url: `${SITE.url}/perps/${a.slug}`,
      asOfIso: page ? new Date(page.asOf * 1000).toISOString() : null,
      jsonUrl: `${SITE.url}/api/stat/perp-fees`,
    }),
  };
}

const VENUE_TYPE_LABEL: Record<PerpAssetVenueRow["venueType"], string | null> = {
  onchain: null,
  regulated: "regulated",
  cex: "CEX",
};

function VenueCell({ r }: { r: PerpAssetVenueRow }) {
  const meta = PERP_VENUE_META[r.slug];
  const typeLabel = VENUE_TYPE_LABEL[r.venueType];
  const inner = (
    <span className="flex items-center gap-2 min-w-0">
      <ProviderLogo slug={r.productSlug} name={r.name} size={20} />
      <span className="min-w-0">
        <span className="block font-medium text-ink truncate">{r.name}</span>
        <span className="block text-[11px] text-ink-faint truncate">
          {meta?.chainLabel ?? (r.venueType === "cex" ? "Offchain" : "")}
          {typeLabel ? ` · ${typeLabel}` : ""}
        </span>
      </span>
    </span>
  );
  return (
    <td className="px-2 py-2">
      {r.venueType === "cex" ? inner : (
        <Link href={`/products/${r.productSlug}#perp`} className="group hover:underline underline-offset-2">
          {inner}
        </Link>
      )}
    </td>
  );
}

function Cell({ v, best = false, signed = false }: { v: number | null; best?: boolean; signed?: boolean }) {
  const cls = v == null ? " text-ink-faint text-[11px]" : best ? " text-teal-700 font-semibold" : "";
  return (
    <td className={`num mono tabular-nums px-2 py-2 text-right whitespace-nowrap${cls}`}>
      {signed ? fmtSignedBps(v) : fmtBps(v)}
    </td>
  );
}

function Th({ children, href, title }: { children: React.ReactNode; href?: string; title?: string }) {
  return (
    <th className="px-2 py-2 text-right font-medium" title={title}>
      {href ? <Link href={href} className="hover:text-ink underline-offset-2 hover:underline">{children}</Link> : children}
    </th>
  );
}

function VenueTable({ list, showFees, benchHref }: { list: PerpAssetVenueRow[]; showFees: boolean; benchHref: (b: string) => string }) {
  const best: Partial<Record<NumKey, string>> = {};
  const fullMonth = list.filter((r) => (r.funding30dSamples ?? 0) >= FULL_MONTH_MIN);
  // No 7d highlight: rows carry no 7d sample count, so a week averaged
  // from a few hours could win (the 30d column is gated on FULL_MONTH_MIN).
  for (const k of ["allInBps", "slippage100kBps", "takerFeeBps", "funding24hBps"] as NumKey[]) {
    best[k] = cheapest(list, k)?.slug;
  }
  best.funding30dBps = cheapest(fullMonth, "funding30dBps")?.slug;
  return (
    <div className="overflow-x-auto rounded-lg border border-ink/10">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint bg-paper-soft/60 border-b border-ink/10">
            <th className="px-2 py-2 font-medium w-8">#</th>
            <th className="px-2 py-2 font-medium">Venue</th>
            {showFees && (
              <>
                <Th href={benchHref("perp-fees")} title="Taker fee plus half spread plus impact of a $1,000 market long, 24h average (bench perp-fees)">Open $1k</Th>
                <Th href={benchHref("perp-execution-quality")} title="Half spread plus impact of a $100,000 market buy, fee excluded, 24h average, shown only where the book filled it on 90 percent of the ticks (bench perp-execution-quality)">Slippage $100k</Th>
                <Th href={benchHref("perp-fees")} title="Published taker fee, 24h average">Taker</Th>
              </>
            )}
            <Th href="/benchmarks/perp-funding" title="Cost of holding a long for 24 hours at the current rate, 24h average; positive means the long pays (bench perp-funding)">Funding 24h</Th>
            <Th title="A week of funding at the average daily cost over the trailing 7 days">Funding 7d</Th>
            <Th href="/benchmarks/perp-funding-cost-30d" title="A month of funding at the average daily cost over the trailing 30 days; a day count marks an average taken over less than the month (bench perp-funding-cost-30d)">Funding 30d</Th>
          </tr>
        </thead>
        <tbody>
          {list.map((r, i) => {
            const partial = r.funding30dBps != null && (r.funding30dSamples ?? 0) < FULL_MONTH_MIN;
            return (
              <tr key={r.slug} className="border-b border-ink/5 last:border-0 hover:bg-paper-soft/40">
                <td className="px-2 py-2 text-ink-faint mono tabular-nums">{i + 1}</td>
                <VenueCell r={r} />
                {showFees && (
                  <>
                    <Cell v={r.allInBps} best={best.allInBps === r.slug} />
                    <Cell v={r.slippage100kBps} best={best.slippage100kBps === r.slug} />
                    <Cell v={r.takerFeeBps} best={best.takerFeeBps === r.slug} />
                  </>
                )}
                <Cell v={r.funding24hBps} best={best.funding24hBps === r.slug} signed />
                <Cell v={r.funding7dBps} signed />
                <td className={`num mono tabular-nums px-2 py-2 text-right whitespace-nowrap${r.funding30dBps == null ? " text-ink-faint text-[11px]" : best.funding30dBps === r.slug ? " text-teal-700 font-semibold" : ""}`}>
                  {fmtSignedBps(r.funding30dBps)}
                  {partial && (
                    <span className="ml-1 text-[10px] font-normal text-ink-faint" title="Month at the average daily cost of the days measured, less than the full month: the venue joined the cohort recently or its feed dropped hours">
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

function LeadCard({
  label,
  venue,
  value,
  note,
  benchHref,
}: {
  label: string;
  venue: PerpAssetVenueRow | null;
  value: string | null;
  note: string;
  benchHref: string;
}) {
  return (
    <div className="card-soft rounded-lg border border-ink/15 p-4 flex flex-col gap-2 min-h-[120px]">
      <p className="label-mono text-[10px] uppercase tracking-wide text-ink-faint" style={{ fontFamily: "var(--font-mono, monospace)" }}>
        {label}
      </p>
      {venue && value ? (
        <>
          <Link href={`/products/${venue.productSlug}#perp`} className="flex items-center gap-2 group">
            <ProviderLogo slug={venue.productSlug} name={venue.name} size={24} />
            <span className="text-lg font-semibold text-ink group-hover:underline underline-offset-2">{venue.name}</span>
          </Link>
          <p className="text-2xl mono tabular-nums text-ink">{value}</p>
        </>
      ) : (
        <p className="text-sm text-ink-faint">Not enough data yet.</p>
      )}
      <p className="mt-auto text-[11px] text-ink-faint">
        {note} <Link href={benchHref} className="underline underline-offset-2 hover:text-ink">Bench</Link>
      </p>
    </div>
  );
}

export default async function PerpAssetPage({ params }: { params: Promise<{ asset: string }> }) {
  const { asset: slug } = await params;
  const a = perpAssetBySlug(slug);
  if (!a) notFound();

  const [page, headToHead] = await Promise.all([
    fetchPerpAssetPage(a.asset),
    perpHeadToHead().catch(() => []),
  ]);
  const rows = page ? sortPerpAssetRows(page.data.venues) : [];
  const cex = page ? sortPerpAssetRows(page.data.cex) : [];
  const fee = cheapest(rows, "allInBps");
  const slip = cheapest(rows, "slippage100kBps");
  const fullMonth = rows.filter((r) => (r.funding30dSamples ?? 0) >= FULL_MONTH_MIN);
  const fund30 = cheapest(fullMonth, "funding30dBps");
  const asOfIso = page ? new Date(page.asOf * 1000).toISOString() : null;
  const asOfLabel = asOfIso ? asOfIso.slice(0, 16).replace("T", " ") + " UTC" : null;
  const pageUrl = `${SITE.url}/perps/${a.slug}`;
  const others = PERP_ASSETS.filter((x) => x.slug !== a.slug);
  const benchHref = (b: string) => (b === "perp-fees" || b === "perp-execution-quality" ? `/benchmarks/${b}?chain=${a.asset}` : `/benchmarks/${b}`);

  const lead = fee
    ? `${fee.name} is the cheapest venue to open a $1,000 ${a.asset} long right now at ${fmtBps(fee.allInBps)} all in (taker fee plus half spread plus impact, 24h average)${slip ? `; ${slip.name} fills a $100,000 ${a.asset} market order with the least slippage at ${fmtBps(slip.slippage100kBps)}` : ""}${fund30 ? `; over the trailing 30 days ${fund30.name} was the cheapest venue to hold an ${a.asset} long, ${fmtSignedBps(fund30.funding30dBps)} of funding for the month at its average daily rate` : ""}.`
    : `Live ${a.asset} perp data is temporarily unavailable; the per-venue benchmarks below still carry the last measurements.`;

  const faq = [
    {
      q: `Which perp DEX is cheapest to trade ${a.asset} right now?`,
      a: fee
        ? `${fee.name}, at ${fmtBps(fee.allInBps)} all in for a $1,000 market long (taker fee ${fmtBps(fee.takerFeeBps)} plus half spread and impact), averaged over the last 24 hours across ${countWith(rows, "allInBps")} venues the perp-fees harness walks every 30 seconds.`
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
        ? `${fund30.name}, at ${fmtSignedBps(fund30.funding30dBps)} of funding for a month at its average daily cost over the trailing 30 days (positive means the long paid), among the ${fullMonth.length} venues with (nearly) the whole month behind that average. Venues measured for less show the days behind their figure and are not counted for this answer.`
        : `The perp-funding-cost-30d benchmark ranks it once a month of samples exists.`,
    },
    {
      q: "How is funding over 7 and 30 days computed?",
      a: "The cohort harness records every minute each venue's current funding rate normalised to the cost of holding a long for 24 hours. The 7d and 30d columns average that series on an hourly grid and multiply by 7 and 30: a week or a month of funding at the average daily cost the venue quoted, in basis points of notional. Hours the harness could not read are left out of the average, never filled with the last rate. A venue with less than the month behind its average shows its day count next to the figure and is not named the cheapest to hold.",
    },
    {
      q: "Why is a cell marked not measured?",
      a: "Opening cost, slippage and taker fee come from the perp-fees harness, which walks the public order book of eleven venues; a venue outside that walk, or an oracle-priced one, has no such figure. Funding comes from each venue's own endpoint or from the Mobula aggregator; a venue on neither has none. Nothing is estimated to fill a blank.",
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

  const measuredFees = countWith(rows, "allInBps");
  const measuredFunding = countWith(rows, "funding24hBps");

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
            { href: benchHref("perp-fees"), label: "perp-fees" },
            { href: benchHref("perp-execution-quality"), label: "perp-execution-quality" },
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
          <section aria-labelledby="cheapest">
            <h2 id="cheapest" className="display text-xl sm:text-2xl text-ink mb-3">Cheapest right now</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <LeadCard
                label={`Open $1k ${a.asset} long`}
                venue={fee}
                value={fee ? fmtBps(fee.allInBps) : null}
                note={`All in, 24h average, ${measuredFees} venues walked.`}
                benchHref={benchHref("perp-fees")}
              />
              <LeadCard
                label={`Fill $100k ${a.asset} market order`}
                venue={slip}
                value={slip ? fmtBps(slip.slippage100kBps) : null}
                note={`Half spread plus impact, fee excluded, ${countWith(rows, "slippage100kBps")} books deep enough.`}
                benchHref={benchHref("perp-execution-quality")}
              />
              <LeadCard
                label={`Hold ${a.asset} long, 30 days`}
                venue={fund30}
                value={fund30 ? fmtSignedBps(fund30.funding30dBps) : null}
                note={`A month at the average daily cost, ${fullMonth.length} venues with a full month behind it.`}
                benchHref="/benchmarks/perp-funding-cost-30d"
              />
            </div>
          </section>

          <section className="mt-10" aria-labelledby="all-venues">
            <h2 id="all-venues" className="display text-xl sm:text-2xl text-ink mb-2">{rows.length} venues listing {a.asset} perps</h2>
            <p className="text-sm text-ink-soft mb-3 max-w-3xl">
              Ranked by all-in opening cost where measured, then by funding. The best figure of each column is highlighted; a column header links to the bench that produces it. Fees and slippage cover the {measuredFees} venues whose order book the perp-fees harness walks, funding the {measuredFunding} venues with a native or aggregator feed; positive funding means the long paid.
            </p>
            <VenueTable list={rows} showFees benchHref={benchHref} />
          </section>

          {cex.length > 0 && (
            <section className="mt-10" aria-labelledby="cex-ref">
              <h2 id="cex-ref" className="display text-lg sm:text-xl text-ink mb-2">Centralised reference: {a.asset} funding on the big books</h2>
              <p className="text-sm text-ink-soft mb-3 max-w-3xl">
                The same {a.asset} funding cost on the large centralised books, from the Mobula funding feed, for the carry comparison. Fees and slippage are not measured on CEXs.
              </p>
              <VenueTable list={cex} showFees={false} benchHref={benchHref} />
            </section>
          )}
        </>
      ) : (
        <p className="text-sm text-ink-faint italic">
          Per-asset data is temporarily unavailable. The bench pages are still live at{" "}
          <Link href="/benchmarks/perp-fees" className="underline">/benchmarks/perp-fees</Link> and{" "}
          <Link href="/benchmarks/perp-funding" className="underline">/benchmarks/perp-funding</Link>.
        </p>
      )}

      {headToHead.length > 0 && (
        <section className="mt-12 max-w-3xl">
          <h2 className="display text-xl sm:text-2xl text-ink mb-3">Head to head</h2>
          <p className="text-sm text-ink-soft mb-3">
            The venue pairs with the most live benchmarks in common, {a.asset} fees, slippage and funding among them, each on its own comparison page.
          </p>
          <ul className="grid gap-2 sm:grid-cols-2 text-sm">
            {headToHead.map((h) => (
              <li key={h.slug}>
                <Link href={`/compare/${h.slug}`} className="text-ink underline underline-offset-2 hover:text-teal-700">
                  {h.aName} vs {h.bName}
                </Link>
                <span className="text-ink-faint">, {h.count} live {h.count === 1 ? "benchmark" : "benchmarks"}</span>
              </li>
            ))}
          </ul>
        </section>
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
          Fees and slippage: the perp-fees harness walks each venue&apos;s public order book for {a.asset} every 30 seconds at $1k, $10k, $100k and $1M and publishes the all-in cost per tier; this page shows the 24h averages. Funding: the perp-cohort-stats harness reads each venue&apos;s quoted rate every minute (its own endpoint where it publishes one, the Mobula aggregator otherwise), normalises it to a 24h hold, and the 7d and 30d columns are that daily cost averaged over the window times its days. Sources are public and unauthenticated; the methodology is on each bench page.
        </p>
      </footer>
    </article>
  );
}
