import type { Metadata } from "next";
import Link from "next/link";
import { getBenchmark } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { buildCitationMeta, CREATOR_PUBLISHER, DATASET_LICENSE } from "@/lib/dataset-jsonld";
import { fetchPerpCohort, type PerpVenueRow } from "@/lib/perp-stats";
import { headlineSentence, leader, rankedCandidates } from "@/lib/citation";
import { fmtUnit } from "@/lib/format";
import type { Benchmark } from "@/types/benchmark";

/**
 * State of perp DEXes, Q3 2026. A dated, quotable reading of what the
 * perp benchmarks measure at the end of the quarter: who trades what,
 * what it costs to trade and to hold, how far the venues have gone
 * beyond crypto, how much of the volume is backed by positions, and how
 * the tokens are priced against their fees. Every number on the page is
 * the live value of a bench or of the cohort snapshot, with its bench
 * linked, so the report stays true after publication instead of ageing
 * into a stale PDF. Narrative sentences are templated from the data;
 * no figure is typed by hand.
 */

export const revalidate = 3600;

const PATH = "/reports/state-of-perp-dexes-q3-2026";
const TITLE = "State of perp DEXes, Q3 2026: measured, not self-reported";
const QUARTER_END = "2026-09-30";

const usd = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return "n/a";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toFixed(0)}`;
};

function top(b: Benchmark | null | undefined, n = 3) {
  if (!b) return [];
  return rankedCandidates(b).slice(0, n);
}

function BenchLine({ b }: { b: Benchmark | null | undefined }) {
  if (!b) return null;
  return (
    <p className="mt-2 text-sm text-ink-soft">
      {headlineSentence(b)}{" "}
      <Link href={`/benchmarks/${b.slug}`} className="underline underline-offset-2">
        {b.title}
      </Link>
      .
    </p>
  );
}

function RankList({ b, n = 5 }: { b: Benchmark | null | undefined; n?: number }) {
  if (!b) return null;
  const rows = top(b, n);
  if (rows.length === 0) return null;
  return (
    <ol className="mt-2 text-sm text-ink grid gap-1 sm:grid-cols-2">
      {rows.map((r, i) => (
        <li key={r.slug} className="tabular-nums">
          <span className="text-ink-faint mr-1.5">{i + 1}.</span>
          <Link href={`/products/${r.slug}`} className="underline-offset-2 hover:underline">
            {r.name}
          </Link>
          <span className="text-ink-soft"> {fmtUnit(r.ms.p50, b.unit)}</span>
        </li>
      ))}
    </ol>
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const cohort = await fetchPerpCohort();
  // Same ordering as the body: by 30-day volume, never registry order.
  const measured = (cohort?.venues.filter((v) => v.venueType !== "cex") ?? [])
    .filter((v) => v.volume30d != null)
    .sort((a, b) => (b.volume30d ?? 0) - (a.volume30d ?? 0));
  const lead = measured[0];
  const description = lead && lead.volume30d != null
    ? `${cohort!.totals.trackedVenues} perp venues measured from public APIs through Q3 2026: ${lead.name} leads 30-day volume at ${usd(lead.volume30d)}, cohort open interest ${usd(cohort!.totals.cohortOpenInterest)}. Fees, funding, slippage, breadth beyond crypto, volume quality and token valuation, each figure live and linked to its benchmark.`
    : `A dated reading of the perp DEX benchmarks at the end of Q3 2026: volume, open interest, fees, funding, slippage, asset breadth, volume quality and token valuation, every figure live and linked to its benchmark.`;
  return {
    ...pageMetadata({ path: PATH, title: TITLE, description }),
    other: buildCitationMeta({
      title: TITLE,
      url: `${SITE.url}${PATH}`,
      asOfIso: cohort ? new Date(cohort.asOf * 1000).toISOString() : null,
      jsonUrl: `${SITE.url}/api/citable`,
    }),
  };
}

export default async function StateOfPerpDexesQ3Page() {
  const [cohort, fees, slippage, funding, fundingCost, breadth, volOi, longevity, pe, pf, markets] = await Promise.all([
    fetchPerpCohort(),
    getBenchmark("perp-fees"),
    getBenchmark("perp-execution-quality"),
    getBenchmark("perp-funding"),
    getBenchmark("perp-funding-cost-30d"),
    getBenchmark("perp-asset-breadth"),
    getBenchmark("perp-volume-oi-ratio"),
    getBenchmark("perp-protocol-longevity"),
    getBenchmark("perp-pe-ratio"),
    getBenchmark("perp-pf-ratio"),
    getBenchmark("perp-active-markets"),
  ]);
  const measured: PerpVenueRow[] = cohort?.venues.filter((v) => v.venueType !== "cex") ?? [];
  const cex: PerpVenueRow[] = cohort?.venues.filter((v) => v.venueType === "cex") ?? [];
  const byVolume = [...measured].filter((v) => v.volume30d != null).sort((a, b) => (b.volume30d ?? 0) - (a.volume30d ?? 0));
  const lead = byVolume[0] ?? null;
  const totalVol = cohort?.totals.cohortVolume30d ?? 0;
  const top3Share = lead && totalVol > 0 ? byVolume.slice(0, 3).reduce((s, v) => s + (v.volume30d ?? 0), 0) / totalVol : null;
  // 24h, the figure the venues actually report to CoinGecko; the 30-day
  // column on CEX rows is OpenChainBench's own average of that series.
  const cexVol24h = cex.reduce((s, v) => s + (v.volume24h ?? 0), 0);
  const asOfIso = cohort ? new Date(cohort.asOf * 1000).toISOString() : null;
  const asOfLabel = asOfIso ? asOfIso.slice(0, 16).replace("T", " ") + " UTC" : null;
  const pageUrl = `${SITE.url}${PATH}`;

  const feesLead = fees ? leader(fees) : null;
  const slipLead = slippage ? leader(slippage) : null;
  const fundLead = funding ? leader(funding) : null;
  const fundCostLead = fundingCost ? leader(fundingCost) : null;
  const breadthLead = breadth ? leader(breadth) : null;
  const breadthRanked = breadth ? rankedCandidates(breadth) : [];
  const breadthNonZero = breadthRanked.filter((r) => r.ms.p50 > 0).length;
  const volOiRanked = volOi ? rankedCandidates(volOi) : [];
  const volOiHigh = volOiRanked.filter((r) => r.ms.p50 >= 8);

  const sections = [
    { id: "market", label: "Market map" },
    { id: "cost", label: "Cost of trading" },
    { id: "funding", label: "Cost of holding" },
    { id: "beyond-crypto", label: "Beyond crypto" },
    { id: "volume-quality", label: "Volume quality" },
    { id: "risk", label: "Risk and valuation" },
    { id: "method", label: "Method" },
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      buildBreadcrumbJsonLd([
        { name: "Home", item: SITE.url },
        { name: "Perp DEX leaderboard", item: `${SITE.url}/perps` },
        { name: "State of perp DEXes, Q3 2026", item: pageUrl },
      ]),
      {
        "@type": "Report",
        "@id": `${pageUrl}#report`,
        headline: TITLE,
        name: TITLE,
        url: pageUrl,
        datePublished: "2026-09-23",
        ...(asOfIso ? { dateModified: asOfIso } : {}),
        author: CREATOR_PUBLISHER,
        publisher: CREATOR_PUBLISHER,
        license: DATASET_LICENSE,
        isAccessibleForFree: true,
        about: "Perpetual futures decentralised exchanges, third quarter of 2026",
        isBasedOn: [
          `${SITE.url}/benchmarks/perp-volume-share`,
          `${SITE.url}/benchmarks/perp-fees`,
          `${SITE.url}/benchmarks/perp-execution-quality`,
          `${SITE.url}/benchmarks/perp-funding`,
          `${SITE.url}/benchmarks/perp-funding-cost-30d`,
          `${SITE.url}/benchmarks/perp-asset-breadth`,
          `${SITE.url}/benchmarks/perp-volume-oi-ratio`,
          `${SITE.url}/benchmarks/perp-protocol-longevity`,
          `${SITE.url}/benchmarks/perp-pe-ratio`,
          `${SITE.url}/benchmarks/perp-pf-ratio`,
        ],
      },
    ],
  };

  return (
    <article className="mx-auto max-w-3xl px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      <nav aria-label="Breadcrumb" className="text-[12px] text-ink-faint mb-4">
        <Link href="/perps" className="hover:text-ink">Perp DEX leaderboard</Link>
        <span className="mx-1.5">/</span>
        <span className="text-ink-soft">State of perp DEXes, Q3 2026</span>
      </nav>
      <header className="mb-8">
        <p className="label-mono text-teal-600 mb-2">Report</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">State of perp DEXes, Q3 2026</h1>
        <p className="mt-4 text-base sm:text-lg text-ink-soft leading-snug">
          What the perp benchmarks measured at the end of the quarter: who trades what, what it costs to trade and to hold, how far the venues have gone beyond crypto, how much of the volume is backed by positions, and how the tokens are priced against their fees. Every figure below is the live value of a benchmark or of the cohort snapshot, linked to its source, so the report reads true after publication instead of ageing into a PDF. The quarter closes on {QUARTER_END}; the page keeps updating until then and freezes its wording after.
        </p>
        {asOfLabel && (
          <p className="mt-2 text-xs text-ink-muted">
            Data as of <time dateTime={asOfIso!}>{asOfLabel}</time>. Published 2026-09-23 by OpenChainBench, CC BY 4.0.
          </p>
        )}
        <nav className="mt-4 flex flex-wrap gap-2 text-[12px]">
          {sections.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="rounded-full border border-ink/10 px-3 py-1 text-ink-soft hover:text-ink">
              {s.label}
            </a>
          ))}
        </nav>
      </header>

      <section id="market" className="mt-10">
        <h2 className="display text-2xl text-ink">1. Market map</h2>
        {lead ? (
          <p className="mt-3 text-sm text-ink-soft leading-relaxed">
            {cohort!.totals.trackedVenues} venues report a 30-day volume to the cohort harness. {lead.name} leads at {usd(lead.volume30d)}
            {byVolume[1] ? `, ahead of ${byVolume[1].name} (${usd(byVolume[1].volume30d)})` : ""}
            {byVolume[2] ? ` and ${byVolume[2].name} (${usd(byVolume[2].volume30d)})` : ""}.
            {top3Share != null ? ` The top three carry ${(top3Share * 100).toFixed(0)} percent of the ${usd(totalVol)} the measured cohort traded over 30 days;` : ""} cohort open interest stands at {usd(cohort!.totals.cohortOpenInterest)}.
            {cexVol24h > 0 ? ` For scale, the centralised books the board carries as reference report ${usd(cexVol24h)} of 24-hour derivatives volume to CoinGecko, a figure the venues declare rather than one OpenChainBench measures.` : ""}
          </p>
        ) : (
          <p className="mt-3 text-sm text-ink-faint italic">Cohort data is temporarily unavailable.</p>
        )}
        {byVolume.length > 0 && (
          <ol className="mt-3 text-sm grid gap-1 sm:grid-cols-2">
            {byVolume.slice(0, 10).map((v, i) => (
              <li key={v.slug} className="tabular-nums">
                <span className="text-ink-faint mr-1.5">{i + 1}.</span>
                <Link href={`/products/${v.slug === "gmx-v2" ? "gmx" : v.slug === "trade-xyz" ? "xyz" : v.slug}#perp`} className="underline-offset-2 hover:underline">
                  {v.name}
                </Link>
                <span className="text-ink-soft"> {usd(v.volume30d)} · OI {usd(v.openInterest)}</span>
              </li>
            ))}
          </ol>
        )}
        <BenchLine b={markets} />
        <p className="mt-2 text-xs text-ink-faint">
          Sources: <Link href="/benchmarks/perp-volume-share" className="underline">perp-volume-share</Link>, <Link href="/benchmarks/perp-daily-volume" className="underline">perp-daily-volume</Link>, the <Link href="/perps" className="underline">/perps</Link> cohort snapshot.
        </p>
      </section>

      <section id="cost" className="mt-10">
        <h2 className="display text-2xl text-ink">2. Cost of trading</h2>
        <p className="mt-3 text-sm text-ink-soft leading-relaxed">
          The published taker fee is not what a market order costs. The perp-fees harness walks each venue&apos;s public order book for ETH, BTC and SOL every 30 seconds and adds the fee to the half spread and the impact at $1k, $10k, $100k and $1M.
          {feesLead ? ` At $1,000 on ETH, ${feesLead.name} is the cheapest venue all in at ${fmtUnit(feesLead.value, fees!.unit)} (24h average).` : ""}
          {slipLead ? ` With the fee removed and the size raised to $100,000, ${slipLead.name} fills with the least slippage at ${fmtUnit(slipLead.value, slippage!.unit)}: depth, not rack rate, is what separates venues at size.` : ""}
        </p>
        <RankList b={fees} />
        <BenchLine b={slippage} />
        <p className="mt-2 text-xs text-ink-faint">
          Per asset: <Link href="/perps/eth" className="underline">ETH</Link>, <Link href="/perps/btc" className="underline">BTC</Link>, <Link href="/perps/sol" className="underline">SOL</Link>. Cost at $1M against $1k: <Link href="/benchmarks/perp-cost-slope" className="underline">perp-cost-slope</Link>.
        </p>
      </section>

      <section id="funding" className="mt-10">
        <h2 className="display text-2xl text-ink">3. Cost of holding</h2>
        <p className="mt-3 text-sm text-ink-soft leading-relaxed">
          Funding is quoted per hour or per eight hours; a position pays every settlement. The harness normalises each venue&apos;s rate to the cost of holding a long for 24 hours and integrates it over the month.
          {fundLead ? ` Right now ${fundLead.name} is the cheapest venue to hold an ETH long at ${fmtUnit(fundLead.value, funding!.unit)} per 24 hours.` : ""}
          {fundCostLead ? ` Over the trailing 30 days ${fundCostLead.name} accumulated the least, ${fmtUnit(fundCostLead.value, fundingCost!.unit)} of notional, on a bench that ranks the DEXs and the large centralised books together (the CEX rows come from the Mobula funding feed).` : ""}
        </p>
        <RankList b={fundingCost} />
        <BenchLine b={funding} />
      </section>

      <section id="beyond-crypto" className="mt-10">
        <h2 className="display text-2xl text-ink">4. Beyond crypto</h2>
        <p className="mt-3 text-sm text-ink-soft leading-relaxed">
          The quarter&apos;s structural change is the catalog. Equities, ETFs, indices, FX and commodities as perpetuals moved from a niche (Gains, Ostium) to the largest venues: Hyperliquid through its HIP-3 deployer dexes, Extended, Aster, Vest, Ondo and the regulated Kalshi book.
          {breadthLead ? ` ${breadthLead.name} lists the most non-crypto perp markets, ${fmtUnit(breadthLead.value, breadth!.unit)}, and ${breadthNonZero} of the ${breadthRanked.length} venues on the bench list at least one.` : ""}
        </p>
        <RankList b={breadth} n={6} />
        <BenchLine b={breadth} />
      </section>

      <section id="volume-quality" className="mt-10">
        <h2 className="display text-2xl text-ink">5. Volume quality</h2>
        <p className="mt-3 text-sm text-ink-soft leading-relaxed">
          Volume is the easiest number to manufacture; open interest has to be collateralised. The ratio of the two says how much of a day&apos;s volume is backed by positions that exist at the end of it. Order books with real holders sit between 0.3x and 3x.
          {volOiRanked.length > 0 ? ` ${volOiRanked[0].name} reads ${fmtUnit(volOiRanked[0].ms.p50, volOi!.unit)}, the most position-backed volume of the ${volOiRanked.length} venues measured` : ""}
          {volOiHigh.length > 0 ? `; ${volOiHigh.map((r) => `${r.name} (${fmtUnit(r.ms.p50, volOi!.unit)})`).join(", ")} turn their book over more than eight times a day, where the volume figure deserves a second look.` : "."}
        </p>
        <RankList b={volOi} n={6} />
        <BenchLine b={volOi} />
      </section>

      <section id="risk" className="mt-10">
        <h2 className="display text-2xl text-ink">6. Risk and valuation</h2>
        <p className="mt-3 text-sm text-ink-soft leading-relaxed">
          Two readings the volume leaderboards skip: how long each venue has run without a recorded exploit, and how the tokens that exist are priced against the fees the venues collect.
        </p>
        <BenchLine b={longevity} />
        <RankList b={longevity} n={4} />
        <BenchLine b={pe} />
        <BenchLine b={pf} />
      </section>

      <section id="method" className="mt-10">
        <h2 className="display text-2xl text-ink">7. Method and citation</h2>
        <p className="mt-3 text-sm text-ink-soft leading-relaxed">
          Volume, open interest and market counts come from each venue&apos;s own public API through the perp-cohort-stats harness, every minute; fees and slippage from order-book walks every 30 seconds (perp-fees); funding from the venues&apos; quoted rates normalised to a 24-hour hold. Nothing is self-reported to OpenChainBench, nothing is scraped from another leaderboard, and no venue pays for placement. The centralised rows are the exception and say so: they are what the venue reports to CoinGecko. Every bench page carries its methodology, a JSON endpoint (<code>/api/stat/&lt;slug&gt;</code>) and a citation block; this page carries the same citation meta.
        </p>
        <p className="mt-3 text-sm text-ink-soft">
          Cite as: OpenChainBench, &ldquo;State of perp DEXes, Q3 2026&rdquo;, {pageUrl}, data as of {asOfLabel ?? "the timestamp shown"}. CC BY 4.0.
        </p>
      </section>
    </article>
  );
}
