import type { Metadata } from "next";
import Link from "next/link";
import { getBenchmark } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd, buildFaqPageJsonLd } from "@/lib/jsonld";
import { buildCitationMeta, CREATOR_PUBLISHER, DATASET_LICENSE } from "@/lib/dataset-jsonld";
import { isInsufficient, leaders } from "@/lib/citation";
import { fmtUnit } from "@/lib/format";
import { capSnippet } from "@/lib/seo-text";
import { ProviderLogo } from "@/components/provider-logo";
import {
  LIQUID_BPS,
  RWA_BENCH_SLUGS,
  fundRows,
  hubAsOf,
  stockRows,
  totals,
  type FundRow,
  type RwaBenches,
  type StockRow,
} from "@/lib/rwa-matrix";
import type { Benchmark } from "@/types/benchmark";

/**
 * /rwa: the tokenized real-world asset hub. RWA dashboards rank issuers
 * by the value they declare; this page shows, per asset, what the tokens
 * do on a public chain: how close a tokenized stock trades to Nasdaq on
 * two chains, how far it wanders over a weekend, what $100,000 of it sells
 * for on Solana, whether a treasury token pays its reference yield and
 * trades at its NAV, and how much of the declared supply has no open
 * market at all. Every cell is a live bench value under that bench's own
 * gate (src/lib/rwa-matrix.ts).
 */

export const revalidate = 300;

const PATH = "/rwa";
const TITLE = "Tokenized RWA benchmarks: price, depth, NAV and yield, measured";

async function loadBenches(): Promise<RwaBenches> {
  const entries = await Promise.all(RWA_BENCH_SLUGS.map(async (slug) => [slug, (await getBenchmark(slug)) ?? null] as const));
  return Object.fromEntries(entries);
}

function lead(b: Benchmark | null) {
  if (!b || isInsufficient(b)) return null;
  const l = leaders(b);
  return l.length > 0 ? { list: l, names: joinNames(l.map((x) => x.name)), value: l[0].value, unit: b.unit } : null;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function fmtUSD(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "…";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtBp(v: number | null): string {
  return v == null ? "…" : fmtUnit(v, "bp");
}

function fmtSignedBp(v: number | null): string {
  if (v == null) return "…";
  const s = fmtUnit(Math.abs(v), "bp");
  return v > 0 ? `+${s}` : v < 0 ? `-${s}` : s;
}

function fmtApy(bp: number | null): string {
  return bp == null ? "…" : `${(bp / 100).toFixed(2)}%`;
}

function describe(benches: RwaBenches): string {
  const t = totals(benches);
  const liveCount = RWA_BENCH_SLUGS.filter((s) => benches[s] && !isInsufficient(benches[s]!)).length;
  const depthLead = lead(benches["rwa-solana-depth"]);
  const stockLead = lead(benches["tokenized-stock-peg"]);
  const yieldLead = lead(benches["rwa-yield-accuracy"]);
  const parts: string[] = [];
  if (t.measuredUsd > 0 && t.liquidKnown) parts.push(`${fmtUSD(t.measuredUsd)} of tokenized RWA measured on Solana, ${fmtUSD(t.liquidUsd)} sells $100k within ${LIQUID_BPS} bps, ${fmtUSD(t.noMarketUsd)} has no open market`);
  else if (t.measuredUsd > 0) parts.push(`${fmtUSD(t.measuredUsd)} of tokenized RWA measured on Solana, ${fmtUSD(t.noMarketUsd)} has no open market`);
  if (depthLead) parts.push(`${depthLead.names} cheapest at size (${fmtBp(depthLead.value)})`);
  if (stockLead) parts.push(`${stockLead.names} closest to Nasdaq (${fmtBp(stockLead.value)})`);
  if (yieldLead) parts.push(`${yieldLead.names} closest to its reference yield`);
  // Joined as sentences: capSnippet cuts at a sentence end, not at ";".
  return capSnippet(
    parts.length > 0
      ? `${parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(". ")}. ${liveCount} live benchmarks, read from public chains.`
      : "Tokenized stocks, treasuries, gold and yield funds measured on public chains: price against the market, depth at size, NAV basis, yield delivered against yield promised.",
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const benches = await loadBenches();
  const asOf = hubAsOf(benches);
  return {
    ...pageMetadata({ path: PATH, title: TITLE, description: describe(benches) }),
    other: buildCitationMeta({
      title: TITLE,
      url: `${SITE.url}${PATH}`,
      asOfIso: asOf,
      jsonUrl: `${SITE.url}/api/stat/rwa-solana-depth`,
    }),
  };
}

function SummaryCard({ label, value, tip, accent }: { label: string; value: string; tip: string; accent?: string }) {
  return (
    <div className="card-soft rounded-lg border border-ink/15 p-4" title={tip}>
      <p className="label-mono text-[10px] uppercase tracking-wide text-ink-faint mb-1" style={{ fontFamily: "var(--font-mono, monospace)" }}>
        {label}
      </p>
      <p className="text-2xl mono tabular-nums text-ink" style={accent ? { color: accent } : undefined}>{value}</p>
    </div>
  );
}

function LeadCard({ label, b, note }: { label: string; b: Benchmark | null; note: string }) {
  const l = lead(b);
  return (
    <div className="card-soft rounded-lg border border-ink/15 p-4 flex flex-col gap-2 min-h-[124px]">
      <p className="label-mono text-[10px] uppercase tracking-wide text-ink-faint" style={{ fontFamily: "var(--font-mono, monospace)" }}>
        {label}
      </p>
      {b && l ? (
        <>
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex -space-x-1.5 shrink-0">
              {l.list.slice(0, 2).map((x) => (
                <ProviderLogo key={x.slug} slug={x.slug} name={x.name} size={24} />
              ))}
            </span>
            <span className="text-lg font-semibold text-ink truncate">{l.names}{l.list.length > 1 ? " (tied)" : ""}</span>
          </div>
          <p className="text-2xl mono tabular-nums text-ink">{fmtUnit(l.value, l.unit)}</p>
        </>
      ) : (
        <p className="text-sm text-ink-faint">{b ? "No leader asserted right now." : "Bench unavailable."}</p>
      )}
      <p className="mt-auto text-[11px] text-ink-faint">
        {note} {b && <Link href={`/benchmarks/${b.slug}`} className="underline underline-offset-2 hover:text-ink">Bench</Link>}
      </p>
    </div>
  );
}

function Th({ children, href, title, align = "right" }: { children: React.ReactNode; href?: string; title?: string; align?: "left" | "right" }) {
  return (
    <th className={`px-2 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`} title={title}>
      {href ? <Link href={href} className="hover:text-ink underline-offset-2 hover:underline">{children}</Link> : children}
    </th>
  );
}

function Cell({ text, best = false, muted = false }: { text: string; best?: boolean; muted?: boolean }) {
  const cls = text === "…" || muted ? " text-ink-faint text-[11px]" : best ? " text-teal-700 font-semibold" : "";
  return <td className={`num mono tabular-nums px-2 py-2 text-right whitespace-nowrap${cls}`}>{text}</td>;
}

function AssetCell({ slug, name, sub }: { slug: string; name: string; sub: string }) {
  return (
    <td className="px-2 py-2">
      <Link href={`/products/${slug}`} className="flex items-center gap-2 min-w-0 group">
        <ProviderLogo slug={slug} name={name} size={20} />
        <span className="min-w-0">
          <span className="block font-medium text-ink truncate group-hover:underline underline-offset-2">{name}</span>
          <span className="block text-[11px] text-ink-faint truncate">{sub}</span>
        </span>
      </Link>
    </td>
  );
}

function minSlug<T extends { slug: string }>(rows: T[], pick: (r: T) => number | null): string | undefined {
  let best: T | undefined;
  for (const r of rows) {
    const v = pick(r);
    if (v == null) continue;
    if (!best || v < (pick(best) as number)) best = r;
  }
  return best?.slug;
}

function StockTable({ rows }: { rows: StockRow[] }) {
  const best = {
    robinhood: minSlug(rows, (r) => r.robinhood),
    xstocks: minSlug(rows, (r) => r.xstocks),
    weekend: minSlug(rows, (r) => r.weekend),
    cost100k: minSlug(rows, (r) => r.cost100k),
  };
  return (
    <div className="overflow-x-auto rounded-lg border border-ink/10">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint bg-paper-soft/60 border-b border-ink/10">
            <th className="px-2 py-2 font-medium w-8">#</th>
            <th className="px-2 py-2 font-medium">Stock</th>
            <Th href="/benchmarks/tokenized-stock-peg" title="Uniswap v4 pool on Robinhood Chain vs the Nasdaq price, regular hours, median of the last five sessions (bench tokenized-stock-peg)">Robinhood Chain</Th>
            <Th href="/benchmarks/xstocks-peg" title="Jupiter executable price of the xStock on Solana vs the Nasdaq price, regular hours, median of the last five sessions (bench xstocks-peg)">xStocks, Solana</Th>
            <Th href="/benchmarks/tokenized-stock-weekend-drift" title="Maximum drift of the Robinhood Chain pool from Friday's close over the last completed weekend (bench tokenized-stock-weekend-drift)">Weekend drift</Th>
            <Th href="/benchmarks/rwa-solana-depth" title="Cost of selling $100,000 of the xStock on Jupiter relative to a $100 sale, 24h median (bench rwa-solana-depth)">Sell $100k</Th>
            <Th href="/benchmarks/rwa-solana-depth" title="Token supply of the xStock mint on Solana, valued at the executable price (bench rwa-solana-depth)">On Solana</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.slug} className="border-b border-ink/5 last:border-0 hover:bg-paper-soft/40">
              <td className="px-2 py-2 text-ink-faint mono tabular-nums">{i + 1}</td>
              <AssetCell
                slug={r.slug}
                name={r.ticker}
                sub={[r.robinhood != null ? "Robinhood Chain" : null, r.xstocks != null ? `${r.ticker}x on Solana` : null].filter(Boolean).join(" · ")}
              />
              <Cell text={fmtBp(r.robinhood)} best={best.robinhood === r.slug} />
              <Cell text={fmtBp(r.xstocks)} best={best.xstocks === r.slug} />
              <Cell text={fmtBp(r.weekend)} best={best.weekend === r.slug} />
              <Cell text={fmtBp(r.cost100k)} best={best.cost100k === r.slug} />
              <Cell text={fmtUSD(r.supplyUsd)} muted />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FundTable({ rows }: { rows: FundRow[] }) {
  const bestGap = (() => {
    let best: FundRow | undefined;
    for (const r of rows) if (r.gap != null && (!best || Math.abs(r.gap) < Math.abs(best.gap as number))) best = r;
    return best?.slug;
  })();
  const bestCost = minSlug(rows, (r) => r.cost100k);
  const kindLabel: Record<FundRow["kind"], string> = { treasury: "Tokenized treasury", credit: "Private credit", gold: "Tokenized gold" };
  return (
    <div className="overflow-x-auto rounded-lg border border-ink/10">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint bg-paper-soft/60 border-b border-ink/10">
            <th className="px-2 py-2 font-medium w-8">#</th>
            <th className="px-2 py-2 font-medium">Token</th>
            <Th href="/benchmarks/rwa-yield-accuracy" title="Annualized yield accrued on-chain over the trailing 30 days, from the issuer's oracle, the Chainlink NAV feed or the vault share price (bench rwa-yield-accuracy)">Delivered 30d</Th>
            <Th href="/benchmarks/rwa-yield-accuracy" title="Reference APY: the 30-day mean on the DefiLlama yields feed, read by hand and dated">Reference</Th>
            <Th href="/benchmarks/rwa-yield-accuracy" title="Delivered minus reference, 30 days, in basis points; the bench ranks the absolute value">Gap</Th>
            <Th href="/benchmarks/usdy-nav-basis" title="Median absolute basis between the executable market price and the redemption price the issuer publishes on-chain, closest venue, 24h (bench usdy-nav-basis; USDY only today)">NAV basis</Th>
            <Th href="/benchmarks/rwa-solana-depth" title="Cost of selling $100,000 on Jupiter relative to a $100 sale, 24h median; No open market when Jupiter has no route for one unit (bench rwa-solana-depth)">Sell $100k</Th>
            <Th href="/benchmarks/rwa-solana-depth" title="Token supply of the Solana mint, valued at the executable price, or at $1.00 for BUIDL by design; units for USTB (bench rwa-solana-depth)">On Solana</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.slug} className="border-b border-ink/5 last:border-0 hover:bg-paper-soft/40">
              <td className="px-2 py-2 text-ink-faint mono tabular-nums">{i + 1}</td>
              <AssetCell slug={r.slug} name={r.name} sub={`${r.issuer} · ${kindLabel[r.kind]}`} />
              <Cell text={fmtApy(r.delivered)} />
              <Cell text={fmtApy(r.reference)} />
              <Cell text={fmtSignedBp(r.gap)} best={bestGap === r.slug} />
              <Cell text={fmtBp(r.navBasis)} />
              {r.noMarket ? (
                <td className="px-2 py-2 text-right whitespace-nowrap">
                  <span className="inline-flex items-center text-[11px] px-1.5 py-0.5 rounded border text-amber-700 bg-amber-500/10 border-amber-500/30" title="Jupiter returns no route for one unit of this mint: a transfer-restricted fund that never trades on an open pool">
                    {r.noMarket}
                  </span>
                </td>
              ) : (
                <Cell text={fmtBp(r.cost100k)} best={bestCost === r.slug} />
              )}
              <Cell text={r.supplyUsd != null ? fmtUSD(r.supplyUsd) : r.supplyUnits != null ? `${Math.round(r.supplyUnits).toLocaleString("en-US")} units` : "…"} muted />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function RwaHubPage() {
  const benches = await loadBenches();
  const live = RWA_BENCH_SLUGS.map((s) => benches[s]).filter((b): b is Benchmark => !!b && !isInsufficient(b));
  const pageUrl = `${SITE.url}${PATH}`;
  const asOfIso = hubAsOf(benches);
  const asOfLabel = asOfIso ? asOfIso.slice(0, 16).replace("T", " ") + " UTC" : null;
  const t = totals(benches);
  const stocks = stockRows(benches);
  const funds = fundRows(benches);

  const depthLead = lead(benches["rwa-solana-depth"]);
  const stockLead = lead(benches["tokenized-stock-peg"]);
  const xLead = lead(benches["xstocks-peg"]);
  const yieldLead = lead(benches["rwa-yield-accuracy"]);
  const navLead = lead(benches["usdy-nav-basis"]);
  const wkLead = lead(benches["tokenized-stock-weekend-drift"]);
  const wkWorst = (() => {
    const rows = stocks.filter((r) => r.weekend != null).sort((a, b) => (b.weekend as number) - (a.weekend as number));
    return rows[0] ?? null;
  })();
  // Only the no-market rows with a dollar value are named next to the
  // dollar figure (USTB has units, no price to value them at).
  const noMarketRows = funds.filter((r) => r.noMarket && r.supplyUsd != null);

  const leadSentence = [
    t.measuredUsd > 0 && t.liquidKnown
      ? `Of the ${fmtUSD(t.measuredUsd)} of tokenized RWA supply this page measures on Solana, ${fmtUSD(t.liquidUsd)} sells $100,000 within ${LIQUID_BPS} bps and ${fmtUSD(t.noMarketUsd)} has no open market at all`
      : t.measuredUsd > 0
        ? `Of the ${fmtUSD(t.measuredUsd)} of tokenized RWA supply this page measures on Solana, ${fmtUSD(t.noMarketUsd)} has no open market at all`
        : null,
    stockLead ? `${stockLead.names} tracks Nasdaq tightest on Robinhood Chain at ${fmtBp(stockLead.value)}` : null,
    xLead ? `${xLead.names} on Solana at ${fmtBp(xLead.value)}` : null,
    yieldLead ? `${yieldLead.names} ${yieldLead.list.length > 1 ? "pay" : "pays"} closest to ${yieldLead.list.length > 1 ? "their" : "its"} reference yield, ${fmtBp(yieldLead.value)} off over 30 days` : null,
  ].filter(Boolean).join("; ");

  const faq = [
    {
      q: "How is this different from an RWA dashboard like RWA.xyz?",
      a: "Those dashboards rank issuers by the value they declare, and they are the right place for market size. This page reads what the tokens do on a public chain without asking the issuer: whether a tokenized stock trades at the real market price, what $100,000 of it sells for, whether a tokenized treasury trades at its NAV, whether a yield token accrues the yield a dated 30-day reference says, and how much of the declared supply has no open market. Every number is produced by an open harness, timestamped, and exposed as JSON.",
    },
    {
      q: "How much of Solana's tokenized RWA value can actually be sold?",
      a: t.measuredUsd > 0 && t.liquidKnown
        ? `Of the ${fmtUSD(t.measuredUsd)} of supply the rwa-solana-depth bench values on Solana (as of ${asOfLabel}), ${fmtUSD(t.liquidUsd)} belongs to assets whose $100,000 sale costs ${LIQUID_BPS} bps or less on Jupiter${depthLead ? `, ${depthLead.names} being the cheapest at ${fmtBp(depthLead.value)}` : ""}. ${fmtUSD(t.noMarketUsd)} sits in funds with no route at all${noMarketRows.length > 0 ? ` (${joinNames(noMarketRows.map((r) => r.name))})` : ""}: transfer-restricted funds that never trade on an open pool and can only be redeemed through the issuer.`
        : "The rwa-solana-depth bench measures it every five minutes: the cost of selling $1k, $10k and $100k of each asset on Jupiter, and the on-chain supply of each mint, including the funds with no route. The liquid share was not asserted when this page rendered.",
    },
    {
      q: "Which tokenized stock tracks the real market most closely?",
      a: stockLead || xLead
        ? `${[stockLead ? `${stockLead.names} on Robinhood Chain (${fmtBp(stockLead.value)} median deviation from Nasdaq in regular hours)` : null, xLead ? `${xLead.names} among xStocks on Solana (${fmtBp(xLead.value)})` : null].filter(Boolean).join(" and ")}, as of ${asOfLabel}. Both benches read the on-chain price every minute against the same reference feed: the Uniswap v4 pool spot on Robinhood Chain, the Jupiter executable price on Solana.`
        : "The tokenized-stock-peg and xstocks-peg benches rank it live; the figure was unavailable when this page rendered.",
    },
    {
      q: "What happens to tokenized stocks over the weekend?",
      a: wkLead && wkWorst
        ? `They drift. With Nasdaq closed for about 65 hours nobody has a reference to arbitrage against, so pool prices wander; last weekend ${wkLead.names} moved least from Friday's close (${fmtBp(wkLead.value)} of maximum deviation) and ${wkWorst.ticker} most (${fmtBp(wkWorst.weekend)}). The order changes from one weekend to the next.`
        : "The tokenized-stock-weekend-drift bench publishes one value per completed weekend: the maximum deviation from Friday's close between Friday's last regular tick and Monday's first.",
    },
    {
      q: "Does USDY trade at its NAV?",
      a: navLead
        ? `Not exactly: the closest venue, ${navLead.names}, sits ${fmtBp(navLead.value)} from the redemption price Ondo publishes on-chain (24h median of the absolute basis). A persistent discount is the price of exiting now rather than redeeming through the issuer.`
        : "The usdy-nav-basis bench measures it every minute against the redemption price Ondo publishes on-chain.",
    },
    {
      q: "Which tokenized treasury pays what its reference yield says?",
      a: yieldLead
        ? `${yieldLead.names} tracked ${yieldLead.list.length > 1 ? "their" : "its"} reference APY most tightly over the last 30 days, ${fmtBp(yieldLead.value)} off. The bench compares the yield each token accrued on-chain (NAV growth between two daily prints from the issuer's oracle or Chainlink feed, or the ERC-4626 share price, compounded over the real span) with a reference APY read by hand and dated: the 30-day mean on the DefiLlama yields feed for every token.`
        : "The rwa-yield-accuracy bench compares delivered on-chain yield with a 30-day reference APY for USDY, USTB, OUSG and SyrupUSDC.",
    },
    {
      q: "Can I cite these numbers?",
      a: "Yes. Every figure is reproducible from public sources, released under CC BY 4.0, and each bench exposes /api/stat/<slug> with the same values and timestamp. This page also answers Accept: text/markdown.",
    },
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      buildBreadcrumbJsonLd([
        { name: "Home", item: SITE.url },
        { name: "Tokenized RWA", item: pageUrl },
      ]),
      ...(live.length > 0
        ? [
            {
              "@type": "Dataset",
              "@id": `${pageUrl}#dataset`,
              name: "Tokenized real-world assets: price accuracy, depth at size, NAV basis and yield delivered, per asset",
              description: `OpenChainBench measurements of tokenized stocks, treasuries, gold and yield funds on public chains: deviation from the market price, cost of a $100,000 sale, on-chain supply with and without an open market, basis to the published NAV, delivered against a dated reference yield, across ${live.length} live benchmarks.`,
              url: pageUrl,
              license: DATASET_LICENSE,
              creator: CREATOR_PUBLISHER,
              publisher: CREATOR_PUBLISHER,
              isAccessibleForFree: true,
              ...(asOfIso ? { dateModified: asOfIso } : {}),
              distribution: live.map((b) => ({ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE.url}/api/stat/${b.slug}` })),
              variableMeasured: [
                { "@type": "PropertyValue", name: "Tokenized stock price deviation from market", unitText: "bps" },
                { "@type": "PropertyValue", name: "Cost of a $100,000 sale on Solana", unitText: "bps" },
                { "@type": "PropertyValue", name: "On-chain supply on Solana", unitText: "USD" },
                { "@type": "PropertyValue", name: "Weekend drift from Friday close", unitText: "bps" },
                { "@type": "PropertyValue", name: "USDY basis to published NAV", unitText: "bps" },
                { "@type": "PropertyValue", name: "Delivered minus reference yield, 30d", unitText: "bps" },
              ],
            },
            {
              "@type": "ItemList",
              name: "Tokenized RWA benchmarks by OpenChainBench",
              numberOfItems: live.length,
              itemListElement: live.map((b, i) => ({ "@type": "ListItem", position: i + 1, name: b.title, url: `${SITE.url}/benchmarks/${b.slug}` })),
            },
            buildFaqPageJsonLd(faq, pageUrl, null, "Tokenized RWA benchmarks: frequently asked questions"),
          ]
        : []),
    ],
  };

  return (
    <article className="mx-auto max-w-6xl px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      <header className="mb-8">
        <p className="label-mono text-teal-600 mb-2">Tokenized real-world assets</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">RWA on-chain, measured: price, depth, NAV and yield.</h1>
        <p className="mt-4 max-w-3xl text-base sm:text-lg text-ink-soft leading-snug">
          Dashboards add up what issuers declare. These benchmarks read what the tokens do on a public chain, per asset: whether a tokenized stock trades at the real market price, what $100,000 of it sells for, whether a treasury token trades at its NAV and pays its reference yield, and how much of the declared supply has no open market at all.
          {leadSentence ? ` Right now: ${leadSentence}.` : ""}
        </p>
        {asOfLabel && (
          <p className="mt-2 text-xs text-ink-muted">
            Data as of <time dateTime={asOfIso!}>{asOfLabel}</time>, every cell the live value of its benchmark.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
          {RWA_BENCH_SLUGS.map((slug) => (
            <Link key={slug} href={`/benchmarks/${slug}`} className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15">
              <span className="label-mono text-ink-faint text-[10px]" style={{ fontFamily: "var(--font-mono, monospace)" }}>Bench</span>
              <span className="text-ink">{slug}</span>
            </Link>
          ))}
          <Link href="/methodology" className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 px-3 py-1 text-ink-soft hover:text-ink">
            How OpenChainBench measures
          </Link>
        </div>
      </header>

      <h2 className="display text-xl sm:text-2xl text-ink mb-3">Declared on Solana, and what sells</h2>
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <SummaryCard label="Supply measured on Solana" value={t.measuredUsd > 0 ? fmtUSD(t.measuredUsd) : "…"} tip="Sum of the on-chain supply of every asset in the rwa-solana-depth cohort, valued at the executable price (BUIDL at $1.00 by design). Read from each mint, not from a dashboard." />
        <SummaryCard label={`Sells $100k within ${LIQUID_BPS} bps`} value={t.measuredUsd > 0 && t.liquidKnown ? fmtUSD(t.liquidUsd) : "…"} accent="#0f766e" tip={`Supply of the assets whose $100,000 sale on Jupiter costs ${LIQUID_BPS} bps or less relative to a $100 sale, 24h median.`} />
        <SummaryCard label="No open market" value={t.measuredUsd > 0 ? fmtUSD(t.noMarketUsd) : "…"} accent="#b45309" tip="Supply of the funds for which Jupiter returns no route for one unit: transfer-restricted funds that never trade on an open pool." />
        <SummaryCard label="Assets measured" value={t.assets > 0 ? String(t.assets) : "…"} tip="Distinct tokenized assets across the six RWA benchmarks." />
      </section>

      <section aria-labelledby="leaders" className="mb-10">
        <h2 id="leaders" className="display text-xl sm:text-2xl text-ink mb-3">Leaders right now</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <LeadCard label="Cheapest $100k sale on Solana" b={benches["rwa-solana-depth"]} note="Cost vs a $100 sale, 24h median." />
          <LeadCard label="Closest to Nasdaq, Robinhood Chain" b={benches["tokenized-stock-peg"]} note="Regular hours, median of the last five sessions." />
          <LeadCard label="Closest to Nasdaq, xStocks on Solana" b={benches["xstocks-peg"]} note="Regular hours, median of the last five sessions." />
          <LeadCard label="Pays closest to its reference yield" b={benches["rwa-yield-accuracy"]} note="Absolute gap to a dated 30-day reference APY." />
        </div>
      </section>

      <section id="stocks" className="mb-10" aria-labelledby="h-stocks">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
          <h2 id="h-stocks" className="display text-xl sm:text-2xl text-ink">Tokenized stocks: {stocks.length} equities and ETFs, two chains</h2>
        </div>
        <p className="text-sm text-ink-soft max-w-3xl mb-4">
          One row per stock: how far its Robinhood Chain pool and its xStock on Solana sit from the Nasdaq price in regular hours, how far the pool wandered last weekend, what $100,000 of the xStock sells for on Jupiter, and how much of it exists on Solana. Sorted by the tighter of the two pegs.
        </p>
        {stocks.length > 0 ? <StockTable rows={stocks} /> : <p className="text-sm text-ink-faint italic">The stock benches asserted no ranking when this page rendered.</p>}
        <p className="mt-3 text-[11px] text-ink-faint italic">
          A blank cell (…) is a stock one issuer does not tokenize, a pool that froze at its last swap (five Robinhood Chain names left the cohort in the summer), or a bench that asserts nothing for the row right now. The two peg columns share the reference feed but not the on-chain leg: pool spot on Robinhood Chain, executable Jupiter price on Solana.
        </p>
      </section>

      <section id="funds" className="mb-10" aria-labelledby="h-funds">
        <h2 id="h-funds" className="display text-xl sm:text-2xl text-ink mb-1">Tokenized treasuries, credit and gold</h2>
        <p className="text-sm text-ink-soft max-w-3xl mb-4">
          One row per token: the yield it accrued on-chain over 30 days against a dated reference, its basis to the NAV the issuer publishes, what $100,000 of it sells for on Solana, and its on-chain supply there. Funds that never trade on an open market are kept in the table with their supply, marked as such.
        </p>
        {funds.length > 0 ? <FundTable rows={funds} /> : <p className="text-sm text-ink-faint italic">The fund benches asserted no ranking when this page rendered.</p>}
        <p className="mt-3 text-[11px] text-ink-faint italic">
          Delivered and reference are annualized; the gap is delivered minus reference in basis points and the rwa-yield-accuracy bench ranks its absolute value. The reference is the 30-day mean on the DefiLlama yields feed, read by hand and dated in the bench notes. OUSG and SyrupUSDC have no Solana market to measure; PAXG and BUIDL have no yield row.
        </p>
      </section>

      <section className="mt-12 max-w-3xl" aria-labelledby="scope">
        <h2 id="scope" className="display text-xl sm:text-2xl text-ink mb-3">What is measured, and what is not</h2>
        <ul className="text-sm text-ink-soft leading-relaxed space-y-2 list-disc pl-5">
          <li>Every cell is read from a public chain or a keyless public quote API against a public reference: a Uniswap v4 pool state, a Jupiter quote, a mint&apos;s supply, an issuer&apos;s oracle or Chainlink feed, a vault share price. No figure comes from an issuer&apos;s dashboard; the yield bench&apos;s reference APY is a dated 30-day mean from a public feed, quoted as the promise being tested.</li>
          <li>No declared-value ranking lives here. The supply column is the on-chain supply of each Solana mint, valued at the price the market pays; the funds with no market are counted at their designed unit value (BUIDL) or in units (USTB), and shown as what they are: value that cannot be sold on an open pool.</li>
          <li>Transfer-restricted funds (BUIDL, USTB, OUSG on the NAV side) cannot be market-tested; the pages say so rather than invent a price.</li>
          <li>Cohorts are what the harnesses can read honestly: six Robinhood Chain stocks with active pools, the twelve xStocks with a Jupiter route, two USDY venues, four yield funds, sixteen Solana mints. Growing them is a matter of sources, not of opinion.</li>
        </ul>
      </section>

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

      <footer className="mt-16 pt-6 border-t border-ink/10 text-[12px] text-ink-soft leading-relaxed">
        <h2 className="label-mono text-ink-faint mb-2">How OpenChainBench measures</h2>
        <p>
          Six harnesses, all open: tokenized-stock-peg reads each pool&apos;s spot price on Robinhood Chain and xstocks-peg the Jupiter executable price on Solana, every minute against a public reference, labelled by market session, and the first publishes each weekend&apos;s maximum drift; rwa-solana-depth sells $100, $1k, $10k and $100k of each asset on Jupiter every five minutes and reads each mint&apos;s supply; usdy-nav-basis reads Ondo&apos;s on-chain redemption price and two Solana venues every minute; rwa-yield-accuracy derives each fund&apos;s accrued yield from its NAV between two daily prints and compares it with a dated 30-day reference APY. Sources and methodology are on each bench page; every page answers <code>Accept: text/markdown</code>.
        </p>
      </footer>
    </article>
  );
}
