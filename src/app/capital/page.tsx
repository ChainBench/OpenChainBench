import Link from "next/link";
import { CapitalHubTabs } from "@/components/capital-hub-tabs";
import { AnswersForBench } from "@/components/answers-for-bench";
import { CAPITAL_BENCHES, fmtPct, fmtUsdShort, fmtX, getCapitalHub, type CapitalHub } from "@/lib/capital-hub";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd, buildFaqPageJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { buildCitationMeta, CREATOR_PUBLISHER, DATASET_LICENSE } from "@/lib/dataset-jsonld";

/**
 * Hub for the capital cohorts: where value sits and moves between chains
 * (TVL, bridged value, stablecoin flows, open interest) and how tokens are
 * priced against the fees their protocols earn (P/F, P/S, FDV, float, fee
 * trend against token move). Everything is read from the materialized
 * benches 273, 275, 274, 265 and 277 plus the two daily history blobs the
 * worker publishes; see src/lib/capital-hub.ts.
 *
 * The page names numbers and the peers they are compared against. It does
 * not tell the reader what to do with them: the neutral wording is the
 * product (see the ocb-seo-geo rules and the Gains note in memory).
 */

const TITLE = "Capital flows and token valuation leaderboards";
const PATH = "/capital";
const FALLBACK_DESCRIPTION =
  "TVL, bridged value and stablecoin flows per chain, open interest, and price to fees per token against category medians. Daily history, public data.";

function describe(hub: CapitalHub | null): string {
  if (!hub) return FALLBACK_DESCRIPTION;
  const parts: string[] = [];
  const s = hub.leaders.stableInflow;
  if (s && s.stablesNet30d != null) parts.push(`${s.name} took in ${fmtUsdShort(s.stablesNet30d)} of stablecoins over 30 days`);
  const p = hub.leaders.lowestPfProtocol;
  if (p && p.pf != null) parts.push(`${p.name} has the lowest price to fees at ${fmtX(p.pf)} of ${hub.protocols.length} tokens`);
  if (parts.length === 0) return FALLBACK_DESCRIPTION;
  // Longest candidate that fits the 120 to 158 character SERP budget: both
  // leaders with the long tail, then shorter tails, then one leader.
  const tails = [
    "TVL, bridged value, stablecoin flows, open interest and price to fees per token, from public data.",
    "TVL, bridged value, stablecoin flows, open interest and price to fees per token.",
    "TVL, bridged value, open interest, price to fees.",
  ];
  const candidates = [
    ...tails.map((t) => `${parts.join("; ")}. ${t}`),
    ...tails.map((t) => `${parts[0]}. ${t}`),
  ];
  return candidates.find((c) => c.length >= 120 && c.length <= 158) ?? candidates.find((c) => c.length <= 158) ?? FALLBACK_DESCRIPTION;
}

export async function generateMetadata(): Promise<import("next").Metadata> {
  const hub = await getCapitalHub();
  return {
    ...pageMetadata({ path: PATH, title: TITLE, description: describe(hub) }),
    other: buildCitationMeta({
      title: TITLE,
      url: `${SITE.url}${PATH}`,
      asOfIso: hub.asOf,
      jsonUrl: `${SITE.url}/api/stat/${CAPITAL_BENCHES.protocolPf}`,
    }),
  };
}

export const revalidate = 3600;

export default async function CapitalHubPage() {
  const hub = await getCapitalHub();
  const hasChainFees = hub.chains.some((c) => c.fees30d != null);
  const asOfLabel = hub.asOf ? `${hub.asOf.slice(0, 16).replace("T", " ")} UTC` : null;

  const lede = ledeSentence(hub);
  const faq = buildFaq(hub);

  const breadcrumbLd = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Capital", item: `${SITE.url}${PATH}` },
    ]),
  };
  const faqLd = buildFaqPageJsonLd(faq, `${SITE.url}${PATH}`, null, "Capital flows and token valuation: frequently asked questions");
  const datasetLd = hub.asOf
    ? {
        "@context": "https://schema.org",
        "@type": "Dataset",
        "@id": `${SITE.url}${PATH}#dataset`,
        name: "Capital flows and token valuation per chain and per protocol",
        description:
          "Per chain: DeFi TVL, value secured by the chain's bridges (native, canonical, external), stablecoin float and 30-day net flow, DEX volume, chain fees and revenue. Per token: market cap, fully diluted valuation, float, 30-day fees and revenue, price to fees, price to sales, fee growth against token move, category median. Per venue: open interest. One point per UTC day.",
        url: `${SITE.url}${PATH}`,
        license: DATASET_LICENSE,
        creator: CREATOR_PUBLISHER,
        publisher: CREATOR_PUBLISHER,
        isAccessibleForFree: true,
        dateModified: hub.asOf,
        distribution: [
          { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: "https://kv.openchainbench.com/aggregate/valuation/history.json" },
          { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: "https://kv.openchainbench.com/aggregate/chains/history.json" },
          ...hub.benches.filter((b) => b.live).map((b) => ({ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE.url}/api/stat/${b.slug}` })),
        ],
        variableMeasured: [
          { "@type": "PropertyValue", name: "Bridged TVL", unitText: "USD" },
          { "@type": "PropertyValue", name: "Stablecoin net flow 30d", unitText: "USD" },
          { "@type": "PropertyValue", name: "Price to fees", unitText: "x" },
          { "@type": "PropertyValue", name: "Price to sales", unitText: "x" },
          { "@type": "PropertyValue", name: "Open interest", unitText: "USD" },
        ],
      }
    : null;
  const chainItems = hub.chains.filter((c) => c.hasChainPage).slice(0, 15);
  const protocolItems = hub.protocols.filter((p) => p.hasProductPage).slice(0, 15);
  const itemListLd =
    chainItems.length + protocolItems.length > 0
      ? {
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: "Chains and tokens on the OpenChainBench capital leaderboards",
          description: "Chains ranked by capital (TVL, bridged value, stablecoin flows) and tokens ranked by price to fees.",
          numberOfItems: chainItems.length + protocolItems.length,
          itemListElement: [
            ...chainItems.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, url: `${SITE.url}/chains/${c.slug}` })),
            ...protocolItems.map((p, i) => ({ "@type": "ListItem", position: chainItems.length + i + 1, name: p.name, url: `${SITE.url}/products/${p.slug}` })),
          ],
        }
      : null;

  return (
    <article
      className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16"
      style={{ background: "linear-gradient(180deg, rgba(122,46,31,0.05), rgba(122,46,31,0) 320px)" }}
    >
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbLd) }} />
      {datasetLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(datasetLd) }} />}
      {itemListLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListLd) }} />}
      {faqLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(faqLd) }} />}

      <header className="mb-8">
        <p className="label-mono text-ink-faint mb-2">Capital</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">Capital flows and token valuation, measured on the same axis.</h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Two questions investors ask and no venue answers about itself: where is the capital going (TVL, value secured by
          each chain&apos;s bridges, stablecoin float, open interest) and what does the market pay for a dollar of protocol
          fees (price to fees, price to sales, float, fee trend against the token). Every row uses the same public sources
          and the same windows, so chains and tokens can be read against each other.
        </p>
        {lede && <p className="mt-3 max-w-2xl text-sm text-ink-soft">{lede}</p>}
        {asOfLabel && (
          <p className="mt-2 text-xs text-ink-muted">
            Data as of <time dateTime={hub.asOf ?? undefined}>{asOfLabel}</time>. Gauges refresh hourly; the daily history starts on 25 September 2026
            {hub.historyDays > 1 ? ` and holds ${hub.historyDays} days` : ""}.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
          {hub.benches.map((b) => (
            <Link
              key={b.slug}
              href={`/benchmarks/${b.slug}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-ink/15 px-3 py-1 hover:bg-paper-soft/60"
            >
              <span className="label-mono text-ink-faint text-[10px]" style={{ fontFamily: "var(--font-mono, monospace)" }}>
                Bench
              </span>
              <span className="text-ink">{b.slug}</span>
              {!b.live && <span className="text-[10px] text-ink-faint">staging</span>}
            </Link>
          ))}
          <Link href="/methodology" className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 px-3 py-1 text-ink-soft hover:text-ink">
            How OpenChainBench measures
          </Link>
        </div>
      </header>

      {hub.chains.length + hub.protocols.length + hub.perps.length + hub.pmOi.length > 0 ? (
        <CapitalHubTabs hub={hub} />
      ) : (
        <p className="text-sm text-ink-faint italic">
          Cohort data is temporarily unavailable. The bench pages linked above carry the last measurements.
        </p>
      )}

      <section className="mt-12 max-w-3xl">
        <h2 className="label-mono text-ink-muted">How to read the two tabs</h2>
        <div className="mt-3 space-y-3 text-sm text-ink-soft leading-relaxed">
          <p>
            <strong className="text-ink">Follow the capital.</strong> TVL is a level: what sits in DeFi contracts on the chain today. Bridged value is
            the part of a chain&apos;s value secured that arrived from another chain, and its weekly move is shown against the median move of every
            L2Beat project above $200M, so a chain gaining ground on its peers stands out from a market-wide move. Stablecoin net flow is the
            30-day change in pegged dollars circulating on the chain: dollars appear on a chain when somebody mints or bridges them there, so it is
            the closest public reading of where capital is actually moving. Open interest shows where leveraged positions and prediction bets sit.
          </p>
          <p>
            <strong className="text-ink">Valuation divergences.</strong> Price to fees is market cap over the last 30 days of fees annualized; price to
            sales uses the protocol&apos;s own share of those fees. Each token is read against the fee-weighted median of its category, and the
            &quot;fees up, token down&quot; badge marks the rows where fees grew month over month, the token fell over 30 days and the P/F sits below
            that median, all three at once. The mirror badge marks the opposite. Neither is a recommendation: fees can grow for one month, a
            token can fall for reasons the fee line does not see, and a low float means most of the supply is still to come.
          </p>
        </div>
      </section>

      <section className="mt-10 max-w-3xl">
        <h2 className="label-mono text-ink-muted">Sources and method</h2>
        <div className="mt-3 space-y-3 text-sm text-ink-soft leading-relaxed">
          <p>
            <strong className="text-ink">DeFiLlama</strong> for protocol fees and revenue (dailyFees, dailyRevenue per adapter), chain TVL, DEX volume
            and stablecoin circulating per chain{hasChainFees
              ? ", and per-chain fees (gas plus every protocol tracked on the chain) with the revenue the chain and its protocols kept, through bench 280."
              : "."}{" "}
            Windows are 30 closed UTC days, annualized as 30-day sum times 365/30.
          </p>
          <p>
            <strong className="text-ink">L2Beat</strong> for value secured per scaling chain, split into native, canonical and external, and its
            7-day change; the cohort is the OCB chain registry intersected with L2Beat&apos;s scaling summary.
          </p>
          {hub.benches.some((b) => b.slug === CAPITAL_BENCHES.usdcCorridor && b.live) && (
            <p>
              <strong className="text-ink">Circle CCTP burn events</strong> on Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche and Unichain
              for the USDC corridor column: net USDC that entered each scanned chain over that one bridge in 7 days, read from public RPCs.
              It is one bridge&apos;s ledger, not total cross-chain flow; the stablecoin float change is the bridge-agnostic reading.
            </p>
          )}
          <p>
            <strong className="text-ink">CoinGecko</strong> for market cap, fully diluted valuation, circulating and total supply and the 30-day
            price change. <strong className="text-ink">Polymarket and Kalshi</strong> APIs for prediction-market open interest, DeFiLlama TVL for
            venues that publish none.
          </p>
          <p>
            <strong className="text-ink">Not measured here.</strong> Token unlock schedules (no free source publishes them; float and its 90-day change
            are the closest public proxy), bridge volumes other than the ones OpenChainBench reads itself (DeFiLlama&apos;s bridge endpoints are paid),
            and any figure a venue reports about itself without a public trail. Every number on this page is reproducible from the URLs above and
            released under CC BY 4.0; the daily history is at{" "}
            <a className="underline" href="https://kv.openchainbench.com/aggregate/valuation/history.json">
              valuation/history.json
            </a>{" "}
            and{" "}
            <a className="underline" href="https://kv.openchainbench.com/aggregate/chains/history.json">
              chains/history.json
            </a>
            .
          </p>
        </div>
      </section>

      {faq.length > 0 && (
        <section className="mt-10 max-w-3xl">
          <h2 className="label-mono text-ink-muted">Frequently asked questions</h2>
          <dl className="mt-3 space-y-4">
            {faq.map((f) => (
              <div key={f.q}>
                <dt className="text-sm font-medium text-ink">{f.q}</dt>
                <dd className="mt-1 text-sm text-ink-soft leading-relaxed">{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <AnswersForBench benchSlugs={[CAPITAL_BENCHES.protocolPf, CAPITAL_BENCHES.perpPf, CAPITAL_BENCHES.stableFlow, CAPITAL_BENCHES.bridgedTvl]} />
    </article>
  );
}

function ledeSentence(hub: CapitalHub): string {
  if (!hub.asOf) return "";
  const parts: string[] = [];
  const b = hub.leaders.bridgedTvl;
  if (b && b.bridgedTvl != null) parts.push(`${b.name} secures the most bridged value at ${fmtUsdShort(b.bridgedTvl)}`);
  const s = hub.leaders.stableInflow;
  if (s && s.stablesNet30d != null && s.stablesNet30d > 0) parts.push(`${s.name} took in the most stablecoins over 30 days at ${fmtUsdShort(s.stablesNet30d)}`);
  const p = hub.leaders.lowestPfProtocol;
  if (p && p.pf != null) parts.push(`${p.name} has the lowest price to fees at ${fmtX(p.pf)} of ${hub.protocols.length} tokens`);
  const o = hub.leaders.pmOi;
  if (o) parts.push(`${o.name} holds the most prediction-market open interest at ${fmtUsdShort(o.oi)}`);
  if (parts.length === 0) return "";
  return `As of ${hub.asOf.slice(0, 10)}, ${parts.join("; ")}.`;
}

function buildFaq(hub: CapitalHub): { q: string; a: string }[] {
  const s = hub.leaders.stableInflow;
  const p = hub.leaders.lowestPfProtocol;
  const b = hub.leaders.bridgedTvl;
  const diverging = hub.protocols.filter((r) => r.signal === "fees-up-token-down");
  return [
    {
      q: "Which chain gained the most stablecoins this month?",
      a:
        s && s.stablesNet30d != null
          ? `${s.name}: its pegged-USD float ${s.stablesNet30d >= 0 ? "grew" : "shrank"} by ${fmtUsdShort(Math.abs(s.stablesNet30d))} over the last 30 days${s.stablesChange30dPct != null ? ` (${fmtPct(s.stablesChange30dPct)})` : ""}, the largest move in the ${hub.chains.filter((c) => c.stablesNet30d != null).length}-chain cohort DeFiLlama tracks above $100M of float.`
          : "The Follow the capital tab ranks every tracked chain by the 30-day change in its stablecoin float, from DeFiLlama's per-chain circulating series.",
    },
    {
      q: "Which token trades at the lowest price to fees?",
      a:
        p && p.pf != null
          ? `${p.name} has the lowest price to fees at ${fmtX(p.pf)}: its market cap is ${fmtX(p.pf)} the fees its protocol earned over the last 30 days annualized${p.categoryMedianPf != null ? `, against a ${p.category} median of ${fmtX(p.categoryMedianPf)}` : ""}. Low is not a verdict: a token can trade at a low multiple because the market expects the fees to fall, or because most of its supply is still locked.`
          : "The Valuation tab ranks tokens by market cap over annualized 30-day fees; the category median sits next to each row so a multiple is read against its peers, never alone.",
    },
    {
      q: "What does the fees up, token down badge mean?",
      a:
        diverging.length > 0
          ? `Three things at once: the protocol's 30-day fees grew against the prior 30 days, its token fell over the same 30 days, and its price to fees sits below its category median. ${diverging.length} of ${hub.protocols.length} tokens match today, ${diverging
              .slice(0, 3)
              .map((r) => r.name)
              .join(", ")} among them. It is a screen for further reading, not a signal to act on.`
          : "Three things at once: the protocol's 30-day fees grew against the prior 30 days, its token fell over the same 30 days, and its price to fees sits below its category median. No token matches all three today.",
    },
    {
      q: "Where does bridged value come from and why are Ethereum and Solana missing from it?",
      a:
        b && b.bridgedTvl != null
          ? `From L2Beat's value secured per scaling chain, split into native, canonical and external; ${b.name} leads at ${fmtUsdShort(b.bridgedTvl)}. Settled L1s have no host chain and therefore no bridged balance to report, so they appear in the TVL and stablecoin columns only.`
          : "From L2Beat's value secured per scaling chain, split into native, canonical and external. Settled L1s have no host chain and therefore no bridged balance to report, so they appear in the TVL and stablecoin columns only.",
    },
    {
      q: "Can I get this data as a file or over an API?",
      a: "Yes. Two daily JSON files hold one point per UTC day per chain and per token (valuation/history.json and chains/history.json on kv.openchainbench.com), every bench has a /api/stat endpoint, and the MCP server answers PromQL over the same gauges for ranges up to 90 days. All of it is CC BY 4.0.",
    },
  ];
}
