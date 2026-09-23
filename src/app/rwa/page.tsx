import type { Metadata } from "next";
import Link from "next/link";
import { getBenchmark } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd, buildFaqPageJsonLd } from "@/lib/jsonld";
import { buildCitationMeta, CREATOR_PUBLISHER, DATASET_LICENSE } from "@/lib/dataset-jsonld";
import { citableAsOf, headlineSentence, isInsufficient, leader, rankedCandidates } from "@/lib/citation";
import { fmtUnit } from "@/lib/format";
import { capSnippet } from "@/lib/seo-text";
import { ProviderLogo } from "@/components/provider-logo";
import type { Benchmark } from "@/types/benchmark";

/**
 * /rwa: the tokenized real-world asset hub. RWA dashboards rank issuers
 * by the value they declare; this page ranks what the tokens do on a
 * public chain, measured by OpenChainBench's own harnesses: whether a
 * tokenized stock trades at its Nasdaq price, whether a tokenized
 * treasury trades at its NAV, and whether a yield token pays the APY it
 * advertises. Every figure is the live value of a bench, linked.
 */

export const revalidate = 3600;

const PATH = "/rwa";
const TITLE = "Tokenized RWA benchmarks: price, NAV and yield, measured";

type Segment = {
  id: string;
  label: string;
  question: string;
  benches: { slug: string; what: string }[];
};

const SEGMENTS: Segment[] = [
  {
    id: "treasuries",
    label: "Tokenized treasuries and yield funds",
    question: "Does the token pay what it promises, and does the market price its NAV?",
    benches: [
      { slug: "rwa-yield-accuracy", what: "Yield distributed on-chain against the APY the issuer advertises, over 30 days." },
      { slug: "usdy-nav-basis", what: "USDY market price against the redemption price Ondo publishes on-chain, every minute." },
    ],
  },
  {
    id: "stocks",
    label: "Tokenized stocks",
    question: "Does the on-chain price track the real market, and what happens when Nasdaq is closed?",
    benches: [
      { slug: "tokenized-stock-peg", what: "Robinhood Chain tokens: the Uniswap v4 pool spot price against the Nasdaq price, regular hours." },
      { slug: "xstocks-peg", what: "Backed xStocks on Solana, Jupiter executable price against the Nasdaq price." },
      { slug: "tokenized-stock-weekend-drift", what: "How far each tokenized stock wanders from Friday close over the 60-hour weekend." },
    ],
  },
];

const ALL_SLUGS = SEGMENTS.flatMap((s) => s.benches.map((b) => b.slug));

async function loadBenches(): Promise<Record<string, Benchmark | null>> {
  const entries = await Promise.all(ALL_SLUGS.map(async (slug) => [slug, (await getBenchmark(slug)) ?? null] as const));
  return Object.fromEntries(entries);
}

/** Leader under the same gate as the bench page: nothing when the bench
 *  itself would not assert one. */
function lead(b: Benchmark | null) {
  if (!b || isInsufficient(b)) return null;
  return leader(b);
}

function rankedRows(b: Benchmark | null) {
  if (!b || isInsufficient(b) || !leader(b)) return [];
  return rankedCandidates(b);
}

function describe(benches: Record<string, Benchmark | null>): string {
  const yieldLead = lead(benches["rwa-yield-accuracy"]);
  const stockLead = lead(benches["tokenized-stock-peg"]);
  const xLead = lead(benches["xstocks-peg"]);
  const parts: string[] = [];
  if (yieldLead) parts.push(`${yieldLead.name} pays closest to its reference yield (${fmtUnit(yieldLead.value, "bps")} off over 30 days)`);
  if (stockLead) parts.push(`${stockLead.name} tracks Nasdaq tightest on Robinhood Chain (${fmtUnit(stockLead.value, "bps")})`);
  if (xLead) parts.push(`${xLead.name} on Solana (${fmtUnit(xLead.value, "bps")})`);
  const live = ALL_SLUGS.filter((s) => benches[s] && !isInsufficient(benches[s]!)).length;
  return capSnippet(
    parts.length > 0
      ? `${parts.join(", ")}. ${live} tokenized RWA benchmarks measured live from public chains.`
      : "Tokenized stocks, treasuries and yield funds measured on public chains: price against the market, NAV basis, yield delivered against yield promised.",
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const benches = await loadBenches();
  const asOf = ALL_SLUGS.map((s) => (benches[s] ? citableAsOf(benches[s]!) : null)).filter(Boolean).sort().at(-1) ?? null;
  return {
    ...pageMetadata({ path: PATH, title: TITLE, description: describe(benches) }),
    other: buildCitationMeta({
      title: TITLE,
      url: `${SITE.url}${PATH}`,
      asOfIso: asOf,
      jsonUrl: `${SITE.url}/api/stat/rwa-yield-accuracy`,
    }),
  };
}

function LeadCard({ b, label }: { b: Benchmark | null; label: string }) {
  const l = lead(b);
  return (
    <div className="card-soft rounded-lg border border-ink/15 p-4 flex flex-col gap-2 min-h-[132px]">
      <p className="label-mono text-[10px] uppercase tracking-wide text-ink-faint" style={{ fontFamily: "var(--font-mono, monospace)" }}>
        {label}
      </p>
      {b && l ? (
        <>
          <Link href={`/products/${l.slug}`} className="flex items-center gap-2 group min-w-0">
            <ProviderLogo slug={l.slug} name={l.name} size={22} />
            <span className="text-lg font-semibold text-ink truncate group-hover:underline underline-offset-2">{l.name}</span>
          </Link>
          <p className="text-2xl mono tabular-nums text-ink">{fmtUnit(l.value, b.unit)}</p>
          <p className="mt-auto text-[11px] text-ink-faint">
            {b.metric}, {b.window ?? "24h"}.{" "}
            <Link href={`/benchmarks/${b.slug}`} className="underline underline-offset-2 hover:text-ink">Bench</Link>
          </p>
        </>
      ) : (
        <p className="text-sm text-ink-faint">{b ? "No leader asserted right now (sample below the bench's floor)." : "Bench unavailable."}</p>
      )}
    </div>
  );
}

function BenchBlock({ b, what }: { b: Benchmark | null; what: string }) {
  if (!b) return null;
  const rows = rankedRows(b).slice(0, 6);
  const ranked = rankedRows(b).length;
  const asOf = citableAsOf(b);
  return (
    <div className="rounded-lg border border-ink/10 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-ink">
          <Link href={`/benchmarks/${b.slug}`} className="hover:underline underline-offset-2">{b.title}</Link>
        </h3>
        <span className="label-mono text-[10px] text-ink-faint" style={{ fontFamily: "var(--font-mono, monospace)" }}>
          № {b.number} · {ranked} ranked{asOf ? ` · ${asOf.slice(0, 16).replace("T", " ")} UTC` : ""}
        </span>
      </div>
      <p className="mt-1 text-sm text-ink-soft">{what}</p>
      <p className="mt-2 text-sm text-ink">{headlineSentence(b)}</p>
      {rows.length > 0 && (
        <ol className="mt-3 grid gap-1 sm:grid-cols-2 text-sm">
          {rows.map((r, i) => (
            <li key={r.slug} className="flex items-center gap-2 tabular-nums">
              <span className="text-ink-faint w-4">{i + 1}.</span>
              <ProviderLogo slug={r.slug} name={r.name} size={16} />
              <Link href={`/products/${r.slug}`} className="text-ink hover:underline underline-offset-2 truncate">{r.name}</Link>
              <span className={`ml-auto mono ${i === 0 ? "text-teal-700 font-semibold" : "text-ink-soft"}`}>{fmtUnit(r.ms.p50, b.unit)}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-[12px] text-ink-faint">
        JSON: <Link href={`/api/stat/${b.slug}`} className="underline underline-offset-2">/api/stat/{b.slug}</Link>
      </p>
    </div>
  );
}

export default async function RwaHubPage() {
  const benches = await loadBenches();
  const live = ALL_SLUGS.map((s) => benches[s]).filter((b): b is Benchmark => !!b && !isInsufficient(b));
  const pageUrl = `${SITE.url}${PATH}`;
  const asOfIso = live.map((b) => citableAsOf(b)).filter((x): x is string => !!x).sort().at(-1) ?? null;
  const asOfLabel = asOfIso ? asOfIso.slice(0, 16).replace("T", " ") + " UTC" : null;

  const yieldLead = lead(benches["rwa-yield-accuracy"]);
  const navLead = lead(benches["usdy-nav-basis"]);
  const stockLead = lead(benches["tokenized-stock-peg"]);
  const xLead = lead(benches["xstocks-peg"]);
  const wkLead = lead(benches["tokenized-stock-weekend-drift"]);

  const leadSentence = [
    yieldLead ? `${yieldLead.name} pays closest to its reference yield, ${fmtUnit(yieldLead.value, "bps")} off over the trailing 30 days` : null,
    stockLead ? `${stockLead.name} is the tokenized stock that tracks Nasdaq tightest on Robinhood Chain at ${fmtUnit(stockLead.value, "bps")}` : null,
    xLead ? `${xLead.name} on Solana at ${fmtUnit(xLead.value, "bps")}` : null,
    navLead ? `USDY trades ${fmtUnit(navLead.value, "bps")} from its published NAV on ${navLead.name}` : null,
  ].filter(Boolean).join("; ");

  const faq = [
    {
      q: "How is this different from an RWA dashboard like RWA.xyz?",
      a: "Those dashboards rank issuers by the value they declare, and they are the right place for market size. This page ranks behaviour that can be read from a public chain without asking the issuer: whether a tokenized stock trades at the real market price, whether a tokenized treasury trades at its NAV, and whether a yield token distributes the APY it advertises. Every number is produced by an open harness, timestamped, and exposed as JSON.",
    },
    {
      q: "Which tokenized stock tracks the real market most closely?",
      a: stockLead || xLead
        ? `${[stockLead ? `${stockLead.name} on Robinhood Chain (${fmtUnit(stockLead.value, "bps")} median deviation from Nasdaq in regular hours)` : null, xLead ? `${xLead.name} among xStocks on Solana (${fmtUnit(xLead.value, "bps")})` : null].filter(Boolean).join(" and ")}, as of ${asOfLabel}. Both benches read the on-chain price every minute against the same reference feed (the Uniswap v4 pool spot on Robinhood Chain, the Jupiter executable price on Solana).`
        : "The tokenized-stock-peg and xstocks-peg benches rank it live; the figure was unavailable when this page rendered.",
    },
    {
      q: "Does USDY trade at its NAV?",
      a: navLead
        ? `Not exactly: the closest venue, ${navLead.name}, sits ${fmtUnit(navLead.value, "bps")} from the redemption price Ondo publishes on-chain (24h median of the absolute basis). A persistent discount is the price of exiting now rather than redeeming through the issuer.`
        : "The usdy-nav-basis bench measures it every minute against the redemption price Ondo publishes on-chain.",
    },
    {
      q: "Which tokenized treasury pays what its reference yield says?",
      a: yieldLead
        ? `${yieldLead.name} tracked its reference APY most tightly over the last 30 days, ${fmtUnit(yieldLead.value, "bps")} off. The bench compares the yield each token accrued on-chain (NAV growth between two daily prints from the issuer's oracle or Chainlink feed, or the ERC-4626 share price, compounded over the real span) with a reference APY read by hand and dated: the 30-day mean on the DefiLlama yields feed for every token, the same window as the delivered figure (the issuer's own displayed APY is kept in the notes).`
        : "The rwa-yield-accuracy bench compares delivered on-chain yield with a 30-day reference APY for USDY, USTB, OUSG and SyrupUSDC.",
    },
    {
      q: "What happens to tokenized stocks over the weekend?",
      a: wkLead
        ? `They drift. With Nasdaq closed for 60 hours nobody has a reference to arbitrage against, so pool prices wander; ${wkLead.name} wandered least last weekend at ${fmtUnit(wkLead.value, "bps")} of maximum deviation from Friday's close, thin pools several hundred basis points.`
        : "The tokenized-stock-weekend-drift bench measures the maximum deviation from Friday close across the 60-hour closed-market window.",
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
              name: "Tokenized real-world assets: price accuracy, NAV basis and yield delivered, per token",
              description: `OpenChainBench measurements of tokenized stocks, treasuries and yield funds on public chains: deviation from the market price, basis to the published NAV, delivered against advertised yield, across ${live.length} live benchmarks.`,
              url: pageUrl,
              license: DATASET_LICENSE,
              creator: CREATOR_PUBLISHER,
              publisher: CREATOR_PUBLISHER,
              isAccessibleForFree: true,
              ...(asOfIso ? { dateModified: asOfIso } : {}),
              distribution: live.map((b) => ({ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE.url}/api/stat/${b.slug}` })),
              variableMeasured: [
                { "@type": "PropertyValue", name: "Tokenized stock price deviation from market", unitText: "bps" },
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
    <article className="mx-auto max-w-5xl px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      <header className="mb-8">
        <p className="label-mono text-teal-600 mb-2">Tokenized real-world assets</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">RWA on-chain, measured: price, NAV and yield</h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Dashboards count what issuers declare. These benchmarks read what the tokens do on a public chain: whether a tokenized stock trades at the real market price, whether a tokenized treasury trades at its NAV, and whether a yield token pays the APY it advertises.
          {leadSentence ? ` Right now ${leadSentence}.` : ""}
        </p>
        {asOfLabel && (
          <p className="mt-2 text-xs text-ink-muted">
            Data as of <time dateTime={asOfIso!}>{asOfLabel}</time>, every figure the live value of its benchmark.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
          {ALL_SLUGS.map((slug) => (
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

      <section aria-labelledby="leaders">
        <h2 id="leaders" className="display text-xl sm:text-2xl text-ink mb-3">Leaders right now</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <LeadCard b={benches["rwa-yield-accuracy"]} label="Pays closest to its reference yield" />
          <LeadCard b={benches["usdy-nav-basis"]} label="USDY venue closest to NAV" />
          <LeadCard b={benches["tokenized-stock-peg"]} label="Tokenized stock closest to Nasdaq, Robinhood Chain" />
          <LeadCard b={benches["xstocks-peg"]} label="xStock closest to Nasdaq, Solana" />
          <LeadCard b={benches["tokenized-stock-weekend-drift"]} label="Least weekend drift" />
        </div>
      </section>

      {SEGMENTS.map((seg) => (
        <section key={seg.id} id={seg.id} className="mt-12" aria-labelledby={`h-${seg.id}`}>
          <h2 id={`h-${seg.id}`} className="display text-xl sm:text-2xl text-ink">{seg.label}</h2>
          <p className="mt-1 text-sm text-ink-soft max-w-3xl">{seg.question}</p>
          <div className="mt-4 grid gap-4">
            {seg.benches.map((b) => (
              <BenchBlock key={b.slug} b={benches[b.slug]} what={b.what} />
            ))}
          </div>
        </section>
      ))}

      <section className="mt-12 max-w-3xl" aria-labelledby="scope">
        <h2 id="scope" className="display text-xl sm:text-2xl text-ink mb-3">What is measured, and what is not</h2>
        <ul className="text-sm text-ink-soft leading-relaxed space-y-2 list-disc pl-5">
          <li>Every row is read from a public chain or a keyless public quote API against a public reference: a Uniswap v4 pool state, a Jupiter quote, an issuer&apos;s oracle or Chainlink feed, a vault share price. No figure comes from an issuer&apos;s own dashboard; the yield bench&apos;s reference APY is a dated 30-day mean from a public feed, quoted as the promise being tested.</li>
          <li>No TVL or market-size ranking lives here. Declared value is a claim about custody off-chain; market data sites rank it. OpenChainBench ranks the behaviour a holder can verify.</li>
          <li>Transfer-restricted funds (BUIDL, BENJI, OUSG on the NAV side) cannot be market-tested because they never trade on an open pool; the pages say so rather than invent a price.</li>
          <li>Cohorts are what the harnesses can read honestly: six Robinhood Chain stocks with active pools (five more froze at their last swap and left), the xStocks with a Jupiter route, two USDY venues, four yield funds. Growing them is a matter of sources, not of opinion.</li>
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
          Five harnesses, all open: tokenized-stock-peg reads each pool&apos;s spot price on Robinhood Chain and xstocks-peg the Jupiter executable price on Solana, every minute against a public reference, labelled by market session; usdy-nav-basis reads Ondo&apos;s on-chain redemption price and two Solana venues every minute; rwa-yield-accuracy derives each fund&apos;s distributed yield from its own on-chain mechanism and compares it with the APY the issuer advertises. Sources and methodology are on each bench page; every page answers <code>Accept: text/markdown</code>.
        </p>
      </footer>
    </article>
  );
}
