import type { Metadata } from "next";
import Link from "next/link";
import { SITE } from "@/data/site";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { buildCitationMeta, CREATOR_PUBLISHER, DATASET_LICENSE } from "@/lib/dataset-jsonld";
import { capSnippet } from "@/lib/seo-text";
import { isDevOnlyBench } from "@/lib/removed-benches";
import {
  CAPITAL_BENCHES,
  fmtUsdShort,
  fmtX,
  getCapitalHub,
  type CapitalHub,
  type ChainRow,
  type ProtocolRow,
} from "@/lib/capital-hub";

/**
 * Capital flows and token valuation, September 2026. A dated, quotable
 * reading of the capital benches at the end of the month: where the
 * stablecoins went, which L2s gained bridged value against their peers,
 * which tokens trade lowest per dollar of fees and where fees and token
 * prices moved apart. Every figure is the live value of a bench or of
 * the daily history, linked to its source, so the report stays true
 * after publication. Narrative sentences are templated from the data;
 * no figure is typed by hand and no row is called a buy.
 */

export const revalidate = 3600;

const SLUG = "2026-09-capital-flows-and-valuation";
const PATH = `/reports/capital/${SLUG}`;
const TITLE = "Capital flows and token valuation, September 2026";
const PUBLISHED = "2026-09-25";
const MONTH_END = "2026-09-30";

const signed = (v: number | null, digits = 1): string => {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
};
const floatPct = (v: number | null): string => (v == null || !Number.isFinite(v) ? "n/a" : `${v.toFixed(0)}%`);
const signedUsd = (v: number | null): string => {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return `${v < 0 ? "-" : "+"}${fmtUsdShort(Math.abs(v))}`;
};

function byStables(hub: CapitalHub): ChainRow[] {
  return hub.chains.filter((c) => c.stablesNet30d != null).sort((a, b) => (b.stablesNet30d ?? 0) - (a.stablesNet30d ?? 0));
}
function byExcess(hub: CapitalHub): ChainRow[] {
  // L2s above $100M of bridged value: below that a single deposit moves the weekly figure by tens of percent.
  return hub.chains
    .filter((c) => c.excess7dPct != null && c.bridgedTvl != null && c.bridgedTvl >= 1e8)
    .sort((a, b) => (b.excess7dPct ?? 0) - (a.excess7dPct ?? 0));
}
function divergences(hub: CapitalHub): ProtocolRow[] {
  return hub.protocols.filter((p) => p.signal === "fees-up-token-down");
}
function mirrors(hub: CapitalHub): ProtocolRow[] {
  return hub.protocols.filter((p) => p.signal === "fees-down-token-up");
}

function describe(hub: CapitalHub | null): string {
  const parts: string[] = [];
  const s = hub ? byStables(hub)[0] : null;
  if (s?.stablesNet30d != null) parts.push(`${s.name} added ${fmtUsdShort(s.stablesNet30d)} of stablecoins in 30 days`);
  const p = hub?.leaders.lowestPfProtocol;
  if (p?.pf != null) parts.push(`${p.name} trades at ${fmtX(p.pf)} price to fees`);
  const n = hub ? divergences(hub).length : 0;
  if (n > 0) parts.push(`${n} tokens fell while their fees grew`);
  // Sentences, longest first; capSnippet keeps whole sentences under the SERP budget.
  const tail = "Stablecoin flows, bridged value, open interest and price to fees, read live from public data.";
  const sentences = parts.length > 0 ? [`${parts[0]}.`, ...(parts.length > 1 ? [`${parts.slice(1).join("; ")}.`] : []), tail] : [tail];
  return capSnippet(sentences.join(" "), 158);
}

export async function generateMetadata(): Promise<Metadata> {
  let hub: CapitalHub | null = null;
  try {
    hub = await getCapitalHub();
  } catch {
    hub = null;
  }
  return {
    ...pageMetadata({ path: PATH, title: TITLE, description: describe(hub) }),
    other: buildCitationMeta({
      title: TITLE,
      url: `${SITE.url}${PATH}`,
      asOfIso: hub?.asOf ?? null,
      jsonUrl: `${SITE.url}/api/stat/${CAPITAL_BENCHES.protocolPf}`,
    }),
  };
}

function ChainLink({ c }: { c: ChainRow }) {
  return c.hasChainPage ? (
    <Link href={`/chains/${c.slug}`} className="underline underline-offset-2">{c.name}</Link>
  ) : (
    <span>{c.name}</span>
  );
}
function ProtocolLink({ p }: { p: { slug: string; name: string; hasProductPage: boolean } }) {
  return p.hasProductPage ? (
    <Link href={`/products/${p.slug}`} className="underline underline-offset-2">{p.name}</Link>
  ) : (
    <span>{p.name}</span>
  );
}

const BENCH_LABEL: Record<string, string> = {
  [CAPITAL_BENCHES.bridgedTvl]: "Bridged TVL per chain",
  [CAPITAL_BENCHES.stableFlow]: "Stablecoin flows per chain",
  [CAPITAL_BENCHES.protocolPf]: "Protocol price to fees",
  [CAPITAL_BENCHES.perpPf]: "Perp DEX price to fees",
  [CAPITAL_BENCHES.pmOi]: "Prediction market open interest",
};

function BenchLink({ slug }: { slug: string }) {
  return (
    <Link href={`/benchmarks/${slug}`} className="underline underline-offset-2">
      {BENCH_LABEL[slug] ?? slug}
    </Link>
  );
}

export default async function CapitalReportPage() {
  let hub: CapitalHub | null = null;
  try {
    hub = await getCapitalHub();
  } catch {
    hub = null;
  }
  const pageUrl = `${SITE.url}${PATH}`;
  const asOfIso = hub?.asOf ?? null;
  const asOfLabel = asOfIso ? asOfIso.slice(0, 16).replace("T", " ") + " UTC" : null;

  const stables = hub ? byStables(hub) : [];
  const inflows = stables.filter((c) => (c.stablesNet30d ?? 0) > 0);
  const outflows = [...stables].reverse().filter((c) => (c.stablesNet30d ?? 0) < 0);
  const inflowTotal = inflows.reduce((s, c) => s + (c.stablesNet30d ?? 0), 0);
  const inflowLead = inflows[0] ?? null;
  const excess = hub ? byExcess(hub) : [];
  const excessLead = excess[0] ?? null;
  const excessPositive = excess.filter((c) => (c.excess7dPct ?? 0) > 0).length;
  const protocols = hub?.protocols ?? [];
  const perps = hub?.perps ?? [];
  const pLead = hub?.leaders.lowestPfProtocol ?? null;
  const perpLead = hub?.leaders.lowestPfPerp ?? null;
  const div = hub ? divergences(hub) : [];
  const mir = hub ? mirrors(hub) : [];
  const pmLead = hub?.leaders.pmOi ?? null;
  const perpOiTotal = (hub?.perpOi ?? []).reduce((s, r) => s + r.oi, 0);
  const pmOiTotal = (hub?.pmOi ?? []).reduce((s, r) => s + r.oi, 0);

  const sections = [
    { id: "stablecoins", label: "Stablecoins" },
    { id: "bridged", label: "Bridged value" },
    { id: "open-interest", label: "Open interest" },
    { id: "price-to-fees", label: "Price to fees" },
    { id: "divergences", label: "Divergences" },
    { id: "not-measured", label: "Not measured" },
    { id: "method", label: "Method" },
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      buildBreadcrumbJsonLd([
        { name: "Home", item: SITE.url },
        { name: "Research reports", item: `${SITE.url}/reports` },
        { name: "Capital", item: `${SITE.url}/reports/capital` },
        { name: TITLE, item: pageUrl },
      ]),
      {
        "@type": "Report",
        "@id": `${pageUrl}#report`,
        headline: TITLE,
        name: TITLE,
        url: pageUrl,
        datePublished: PUBLISHED,
        ...(asOfIso ? { dateModified: asOfIso } : {}),
        author: CREATOR_PUBLISHER,
        publisher: CREATOR_PUBLISHER,
        license: DATASET_LICENSE,
        isAccessibleForFree: true,
        about: "Capital flows between blockchains and the valuation of protocol tokens against their fees, September 2026",
        isBasedOn: Object.values(CAPITAL_BENCHES)
          .filter((s) => !isDevOnlyBench(s))
          .map((s) => `${SITE.url}/benchmarks/${s}`),
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
        <Link href="/reports" className="hover:text-ink">Research reports</Link>
        <span className="mx-1.5">/</span>
        <Link href="/reports/capital" className="hover:text-ink">Capital</Link>
        <span className="mx-1.5">/</span>
        <span className="text-ink-soft">September 2026</span>
      </nav>
      <header className="mb-8">
        <p className="label-mono text-teal-600 mb-2">Report</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">{TITLE}</h1>
        <p className="mt-4 text-base sm:text-lg text-ink-soft leading-snug">
          What the capital benches measured at the end of the month: where the stablecoins went, which scaling chains gained bridged value against their peers, how much open interest the perp DEXes and the prediction markets carry, which tokens trade lowest per dollar of fees and where fees and token prices moved apart. Every figure is the current value of a benchmark, linked to its source, and the data-as-of line says when it was read, so a quotation should carry that timestamp. The month closes on {MONTH_END}. The page describes; it does not recommend.
        </p>
        {asOfLabel && (
          <p className="mt-2 text-xs text-ink-muted">
            Data as of <time dateTime={asOfIso!}>{asOfLabel}</time>. Published {PUBLISHED} by OpenChainBench, CC BY 4.0. Live version of this reading: <Link href="/capital" className="underline">/capital</Link>.
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

      {!hub && (
        <p className="mt-6 text-sm text-ink-faint italic">The capital benches are temporarily unavailable; the sections below fill in when they return.</p>
      )}

      <section id="stablecoins" className="mt-10">
        <h2 className="display text-2xl text-ink">1. Where the stablecoins went</h2>
        {hub && stables.length > 0 ? (
          <>
            <p className="mt-3 text-sm text-ink-soft leading-relaxed">
              Stablecoin float is the closest public reading of capital moving between chains: a dollar of USDC or USDT only appears on a chain when someone mints or bridges it there. Over the last 30 days, {inflows.length} of the {stables.length} chains measured gained float and {outflows.length} lost it.
              {inflowLead?.stablesNet30d != null
                ? ` ${inflowLead.name} took the largest inflow, ${fmtUsdShort(inflowLead.stablesNet30d)} (${signed(inflowLead.stablesChange30dPct)} of its float)${inflowTotal > 0 ? `, ${((inflowLead.stablesNet30d / inflowTotal) * 100).toFixed(0)} percent of the ${fmtUsdShort(inflowTotal)} that flowed into the gaining chains` : ""}.`
                : ""}
              {outflows[0]?.stablesNet30d != null ? ` ${outflows[0].name} saw the largest outflow, ${signedUsd(outflows[0].stablesNet30d)} (${signed(outflows[0].stablesChange30dPct)}).` : ""}
            </p>
            <ol className="mt-3 text-sm grid gap-1 sm:grid-cols-2">
              {stables.slice(0, 8).map((c, i) => (
                <li key={c.slug} className="tabular-nums">
                  <span className="text-ink-faint mr-1.5">{i + 1}.</span>
                  <ChainLink c={c} /> {signedUsd(c.stablesNet30d)} <span className="text-ink-faint">({signed(c.stablesChange30dPct)}, float {fmtUsdShort(c.stablesFloat)})</span>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-sm text-ink-soft">
              Dollars and percentages rank differently on purpose: the same inflow is a rounding error on the largest chains and a step change on a chain with a small float. Bench: <BenchLink slug={CAPITAL_BENCHES.stableFlow} />.
            </p>
          </>
        ) : (
          <p className="mt-3 text-sm text-ink-faint italic">Stablecoin flow data is temporarily unavailable.</p>
        )}
      </section>

      <section id="bridged" className="mt-10">
        <h2 className="display text-2xl text-ink">2. L2s gaining bridged value against their peers</h2>
        {hub && excess.length > 0 ? (
          <>
            <p className="mt-3 text-sm text-ink-soft leading-relaxed">
              Bridged value, from L2Beat, is what a scaling chain&apos;s bridges secure. It moves with the price of ETH for every L2 at once, so the reading that separates chains is each one&apos;s 7-day move minus the cohort&apos;s: positive means capital moved toward that chain faster than toward its peers, negative the reverse.
              {excessLead ? ` ${excessLead.name} gained the most against the cohort this week, ${signed(excessLead.excess7dPct)} of excess move (${signed(excessLead.change7dPct)} on its own, ${fmtUsdShort(excessLead.bridgedTvl)} secured).` : ""}
              {` ${excessPositive} of the ${excess.length} L2s above $100M of bridged value beat the cohort over the week.`}
              {hub.leaders.bridgedTvl ? ` By level, ${hub.leaders.bridgedTvl.name} secures the most, ${fmtUsdShort(hub.leaders.bridgedTvl.bridgedTvl)}${hub.leaders.bridgedTvl.bridgedSharePct != null ? `, ${hub.leaders.bridgedTvl.bridgedSharePct.toFixed(1)} percent of the cohort` : ""}.` : ""}
            </p>
            <ol className="mt-3 text-sm grid gap-1 sm:grid-cols-2">
              {excess.slice(0, 8).map((c, i) => (
                <li key={c.slug} className="tabular-nums">
                  <span className="text-ink-faint mr-1.5">{i + 1}.</span>
                  <ChainLink c={c} /> {signed(c.excess7dPct)} vs peers <span className="text-ink-faint">({signed(c.change7dPct)} own, {fmtUsdShort(c.bridgedTvl)})</span>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-sm text-ink-soft">
              Bench: <BenchLink slug={CAPITAL_BENCHES.bridgedTvl} />.
            </p>
          </>
        ) : (
          <p className="mt-3 text-sm text-ink-faint italic">Bridged value data is temporarily unavailable.</p>
        )}
      </section>

      <section id="open-interest" className="mt-10">
        <h2 className="display text-2xl text-ink">3. Open interest: perp DEXes and prediction markets</h2>
        {hub && (hub.perpOi.length > 0 || hub.pmOi.length > 0) ? (
          <>
            <p className="mt-3 text-sm text-ink-soft leading-relaxed">
              Open interest is capital that has to be posted: positions open at the end of the day, not volume that can be manufactured.
              {hub.perpOi.length > 0 ? ` The ${hub.perpOi.length} perp DEXes on the price to fees bench carry ${fmtUsdShort(perpOiTotal)} of open interest; ${hub.perpOi[0].name} holds the most at ${fmtUsdShort(hub.perpOi[0].oi)}.` : ""}
              {pmLead ? ` The prediction markets measured hold ${fmtUsdShort(pmOiTotal)} across ${hub.pmOi.length} venues, ${pmLead.name} first at ${fmtUsdShort(pmLead.oi)}${pmLead.turnover != null ? `, turning over ${pmLead.turnover.toFixed(2)}x of it in 24 hours` : ""}.` : ""}
            </p>
            <p className="mt-2 text-sm text-ink-soft">
              Benches: <BenchLink slug={CAPITAL_BENCHES.pmOi} />, <BenchLink slug={CAPITAL_BENCHES.perpPf} /> (open interest column).
            </p>
          </>
        ) : (
          <p className="mt-3 text-sm text-ink-faint italic">Open interest data is temporarily unavailable.</p>
        )}
      </section>

      <section id="price-to-fees" className="mt-10">
        <h2 className="display text-2xl text-ink">4. What the market pays for a dollar of fees</h2>
        {hub && protocols.length > 0 ? (
          <>
            <p className="mt-3 text-sm text-ink-soft leading-relaxed">
              Price to fees is market cap over the fees a protocol earned in the last 30 days, annualized: how many years of current fee income the market is paying for the token. It is read against the fee-weighted median of the token&apos;s own category, because a launchpad and a lending market should not share a yardstick.
              {pLead?.pf != null ? ` ${pLead.name} trades at the lowest multiple of the ${protocols.length} DeFi tokens measured, ${fmtX(pLead.pf)}${pLead.categoryMedianPf != null ? ` against a ${pLead.category} median of ${fmtX(pLead.categoryMedianPf)}` : ""}${pLead.floatPct != null ? `, with ${floatPct(pLead.floatPct)} of its supply circulating` : ""}.` : ""}
              {perpLead?.pf != null ? ` Among the ${perps.length} perp DEX tokens, ${perpLead.name} is lowest at ${fmtX(perpLead.pf)} price to fees${perpLead.ps != null ? ` and ${fmtX(perpLead.ps)} price to sales` : ""}${perpLead.pfFdv != null ? `; ${fmtX(perpLead.pfFdv)} on fully diluted value` : ""}.` : ""}
              {" "}A low multiple is a description, not a verdict: it can mean the market expects the fees to fall, that most of the supply is still to come, or that the token holds no claim on the fees.
            </p>
            <ol className="mt-3 text-sm grid gap-1 sm:grid-cols-2">
              {protocols.slice(0, 8).map((p, i) => (
                <li key={p.slug} className="tabular-nums">
                  <span className="text-ink-faint mr-1.5">{i + 1}.</span>
                  <ProtocolLink p={p} /> {fmtX(p.pf)} <span className="text-ink-faint">({p.category}{p.categoryMedianPf != null ? `, median ${fmtX(p.categoryMedianPf)}` : ""}, float {floatPct(p.floatPct)})</span>
                </li>
              ))}
            </ol>
            {perps.length > 0 && (
              <ol className="mt-3 text-sm grid gap-1 sm:grid-cols-2">
                {perps.slice(0, 6).map((p, i) => (
                  <li key={p.slug} className="tabular-nums">
                    <span className="text-ink-faint mr-1.5">{i + 1}.</span>
                    <ProtocolLink p={p} /> {fmtX(p.pf)} P/F <span className="text-ink-faint">({fmtX(p.ps)} P/S, {fmtX(p.pfFdv)} FDV/F, float {floatPct(p.floatPct)})</span>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-2 text-sm text-ink-soft">
              Benches: <BenchLink slug={CAPITAL_BENCHES.protocolPf} />, <BenchLink slug={CAPITAL_BENCHES.perpPf} />.
            </p>
          </>
        ) : (
          <p className="mt-3 text-sm text-ink-faint italic">Valuation data is temporarily unavailable.</p>
        )}
      </section>

      <section id="divergences" className="mt-10">
        <h2 className="display text-2xl text-ink">5. Where fees and token prices moved apart</h2>
        {hub && protocols.length > 0 ? (
          <>
            <p className="mt-3 text-sm text-ink-soft leading-relaxed">
              A row is flagged when three things hold at once: the protocol&apos;s fees grew against the previous 30 days, its token fell over the same 30 days, and its price to fees sits below its category median.
              {div.length > 0
                ? ` ${div.length} of the ${protocols.length} tokens measured meet all three right now: ${div.slice(0, 6).map((p) => `${p.name} (fees ${signed(p.feeGrowth30dPct, 0)}, token ${signed(p.priceChange30dPct, 0)}, ${fmtX(p.pf)})`).join(", ")}${div.length > 6 ? ` and ${div.length - 6} more` : ""}.`
                : " No token meets all three right now."}
              {mir.length > 0 ? ` The mirror image, fees down while the token rose above its category median, holds for ${mir.length}: ${mir.slice(0, 4).map((p) => p.name).join(", ")}${mir.length > 4 ? ` and ${mir.length - 4} more` : ""}.` : ""}
              {" "}The flag marks rows where the fee line and the price line disagree. It says nothing about which one is right, and the list changes as either line moves.
            </p>
            {div.length > 0 && (
              <ul className="mt-3 text-sm grid gap-1 sm:grid-cols-2">
                {div.slice(0, 10).map((p) => (
                  <li key={p.slug} className="tabular-nums">
                    <ProtocolLink p={p} /> <span className="text-ink-faint">fees {signed(p.feeGrowth30dPct, 0)} MoM, token {signed(p.priceChange30dPct, 0)} 30d, {fmtX(p.pf)} vs {fmtX(p.categoryMedianPf)} median</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-sm text-ink-soft">
              Live list with the sortable table: <Link href="/capital" className="underline underline-offset-2">/capital</Link>, second tab.
            </p>
          </>
        ) : (
          <p className="mt-3 text-sm text-ink-faint italic">Valuation data is temporarily unavailable.</p>
        )}
      </section>

      <section id="not-measured" className="mt-10">
        <h2 className="display text-2xl text-ink">6. What this report does not measure</h2>
        <ul className="mt-3 text-sm text-ink-soft leading-relaxed list-disc pl-5 space-y-1">
          <li>Token unlock schedules. The float column says how much of the supply circulates today, not when the rest arrives.</li>
          <li>Bridge corridors. Which bridge moved the dollars between two chains needs paid endpoints; the flows here are read from each chain&apos;s float, not from the bridges.</li>
          <li>Net income. Price to fees divides by gross fees; price to sales, on the perp DEX board, divides by the protocol&apos;s own share. Neither is earnings.</li>
          <li>Anything about the future. Every figure describes a window that has closed; the page carries no forecast and no recommendation.</li>
        </ul>
      </section>

      <section id="method" className="mt-10">
        <h2 className="display text-2xl text-ink">7. Method and citation</h2>
        <p className="mt-3 text-sm text-ink-soft leading-relaxed">
          Stablecoin float and flows, TVL, fees and DEX volume come from DeFiLlama&apos;s public endpoints; bridged value from L2Beat; market cap, fully diluted valuation and supply from CoinGecko; prediction market open interest from Polymarket and Kalshi. The harnesses refresh hourly, ratios are computed on 30 closed UTC days annualized, and a daily point per entity is kept at <code>kv.openchainbench.com/aggregate/chains/history.json</code> and <code>kv.openchainbench.com/aggregate/valuation/history.json</code>{hub && hub.historyDays > 0 ? ` (${hub.historyDays} days so far)` : ""}. Every bench page carries its methodology, a JSON endpoint (<code>/api/stat/&lt;slug&gt;</code>) and a citation block; this page carries the same citation meta.
        </p>
        <p className="mt-3 text-sm text-ink-soft">
          Cite as: OpenChainBench, &ldquo;{TITLE}&rdquo;, {pageUrl}, data as of {asOfLabel ?? "the timestamp shown"}. CC BY 4.0.
        </p>
      </section>
    </article>
  );
}
