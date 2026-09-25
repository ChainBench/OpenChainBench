/**
 * Markdown renderings of the pages agents read most: a bench, the perps
 * hub, a product profile. Served by /api/md/<path> and, through the
 * header-conditioned rewrites in next.config.ts (`rewrites()`,
 * beforeFiles), to any client whose Accept header prefers text/markdown
 * on the HTML URL itself (`curl -H 'Accept: text/markdown' /benchmarks/x`).
 * The MCP resource for a bench renders the same text, so an agent gets
 * one document whichever door it comes through.
 */
import { distinctBenchCount } from "@/lib/providers";
import { SITE } from "@/data/site";
import { fmtUnit } from "@/lib/format";
import {
  citableAsOf,
  citationQuote,
  cohortViews,
  headlineSentence,
  isInsufficient,
  rankedCandidates,
} from "@/lib/citation";
import type { Benchmark } from "@/types/benchmark";
import type { PerpCohortSummary, PerpVenueRow } from "@/lib/perp-stats";
import type { ProviderProfile } from "@/lib/providers";
import { perpProductSlug } from "@/lib/perp-product-slug";
import { fmtPct as capPct, fmtUsdShort as capUsd, fmtX as capX, type CapitalHub } from "@/lib/capital-hub-types";

export function rankingLines(b: Benchmark, ranked: ReturnType<typeof rankedCandidates>): string[] {
  // A bench that repurposes the p50/p90/p99/mean slots declares
  // ledger_columns; the Markdown then names the slots the way the table
  // does instead of printing a signed 30d deviation as "p99".
  const slotCols = (b.ledgerColumns ?? []).filter((c) => c.slot);
  if (slotCols.length > 0) {
    return ranked.map((r, i) => {
      const cells = slotCols.map((c) => `${c.label} ${fmtUnit(r.ms[c.slot as "p50" | "p90" | "p99" | "mean"], c.unit ?? b.unit)}`);
      return `${i + 1}. **${r.name}**: ${cells.join(", ")} (success ${r.successRate.toFixed(1)}%, sample ${r.sampleSize ?? "n/a"})`;
    });
  }
  return ranked.map(
    (r, i) =>
      `${i + 1}. **${r.name}**: ${fmtUnit(r.ms.p50, b.unit)} (p99 ${fmtUnit(r.ms.p99, b.unit)}, success ${r.successRate.toFixed(1)}%, sample ${r.sampleSize ?? "n/a"})`,
  );
}

export function benchMarkdown(b: Benchmark): string {
  const insufficient = isInsufficient(b);
  // Shares `rankedCandidates` with `leader()` so the Rankings list matches
  // the Headline sentence and the `rankings` field on /api/stat.
  const ranked = insufficient ? [] : rankedCandidates(b);
  const md: string[] = [];
  md.push(`# ${b.title}`);
  md.push("");
  md.push(`> ${b.subtitle}`);
  md.push("");
  md.push(`- Category: ${b.category}`);
  md.push(`- Metric: ${b.metric} (${b.unit})`);
  md.push(`- Page: ${SITE.url}/benchmarks/${b.slug}`);
  md.push(`- JSON: ${SITE.url}/api/stat/${b.slug}`);
  md.push(`- Source: ${b.source}`);
  md.push(`- License: CC-BY-4.0`);
  {
    const asOf = citableAsOf(b);
    md.push(`- Last sample: ${asOf ?? "(no measurement yet, draft)"}`);
  }
  md.push("");
  md.push(`**Headline.** ${headlineSentence(b)}`);
  md.push("");
  md.push(`**Citation quote.** ${citationQuote(b, SITE.url)}`);
  md.push("");
  if (ranked.length > 0) {
    md.push(`## Rankings (p50, ${b.window ?? "24h"})`);
    md.push("");
    md.push(...rankingLines(b, ranked));
    md.push("");
  }
  for (const c of cohortViews(b).filter((v) => !v.headline)) {
    const cohortRanked = rankedCandidates(c.bench);
    md.push(`## ${c.label} cohort (ranked separately)`);
    md.push("");
    md.push(
      `Never compared with the rows above: different endpoints, 120 s cadence. Page: ${SITE.url}/benchmarks/${b.slug}#tier=${c.tier}, JSON: ${SITE.url}/api/stat/${b.slug}?tier=${c.tier}`,
    );
    md.push("");
    md.push(`**Headline.** ${headlineSentence(c.bench)}`);
    md.push("");
    md.push(...rankingLines(b, cohortRanked));
    md.push("");
  }
  if (b.methodology.length > 0) {
    md.push(`## Methodology`);
    md.push("");
    for (const m of b.methodology) md.push(`- ${m}`);
    md.push("");
  }
  if (b.faq && b.faq.length > 0) {
    md.push(`## Frequently asked`);
    md.push("");
    for (const f of b.faq) {
      md.push(`**${f.q}**`);
      md.push("");
      md.push(f.a);
      md.push("");
    }
  }
  md.push(`---`);
  md.push(`Cite this benchmark: link ${SITE.url}/benchmarks/${b.slug} · JSON ${SITE.url}/api/stat/${b.slug}`);
  return md.join("\n");
}

const usd = (v: number | null): string => {
  if (v == null || !Number.isFinite(v)) return "n/a";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
};
const bps = (v: number | null): string => (v == null || !Number.isFinite(v) ? "n/a" : `${v.toFixed(2)} bps`);
const num = (v: number | null): string => (v == null || !Number.isFinite(v) ? "n/a" : String(Math.round(v)));

const VENUE_TYPE_LABEL: Record<PerpVenueRow["venueType"], string> = {
  onchain: "DEX",
  regulated: "regulated",
  cex: "CEX, venue-reported",
};

export function perpsHubMarkdown(cohort: PerpCohortSummary | null): string {
  const md: string[] = [];
  md.push(`# Perp DEX leaderboard: volume, open interest, fees and funding, measured live`);
  md.push("");
  md.push(`- Page: ${SITE.url}/perps`);
  md.push(`- Per asset: ${SITE.url}/perps/eth · ${SITE.url}/perps/btc · ${SITE.url}/perps/sol`);
  md.push(`- JSON: ${SITE.url}/api/stat/perp-volume-share (volume), ${SITE.url}/api/stat/perp-fees (all-in cost), ${SITE.url}/api/stat/perp-funding (funding)`);
  md.push(`- License: CC-BY-4.0`);
  if (!cohort) {
    md.push("");
    md.push("Cohort data is temporarily unavailable; the bench pages above carry the last measurements.");
    return md.join("\n");
  }
  md.push(`- Data as of: ${new Date(cohort.asOf * 1000).toISOString()}`);
  md.push("");
  // The snapshot keeps registry order; the HTML table sorts client side.
  // Sort here, or the `#` column would number a registry listing.
  const byVolume = (rows: PerpVenueRow[]) =>
    [...rows].sort((a, b) => (b.volume30d ?? -1) - (a.volume30d ?? -1) || a.name.localeCompare(b.name));
  const dex = byVolume(cohort.venues.filter((v) => v.venueType !== "cex"));
  const cex = byVolume(cohort.venues.filter((v) => v.venueType === "cex"));
  const lead = dex[0];
  if (lead && lead.volume30d != null) {
    md.push(
      `**Headline.** ${lead.name} leads ${cohort.totals.trackedVenues} tracked perp DEXes on 30-day volume at ${usd(lead.volume30d)}; cohort open interest ${usd(cohort.totals.cohortOpenInterest)}.`,
    );
    md.push("");
  }
  const table = (rows: PerpVenueRow[]) => {
    md.push(`| # | Venue | Type | Volume 24h | Volume 30d | Open interest | Markets | All-in $1k ETH | Funding 24h ETH |`);
    md.push(`|---|---|---|---|---|---|---|---|---|`);
    rows.forEach((v, i) => {
      md.push(
        `| ${i + 1} | ${v.name} (${SITE.url}/products/${perpProductSlug(v.slug)}) | ${VENUE_TYPE_LABEL[v.venueType]} | ${usd(v.volume24h)} | ${usd(v.volume30d)} | ${usd(v.openInterest)} | ${num(v.activeMarkets)} | ${bps(v.allInFeeBpsEth)} | ${bps(v.funding24hBpsEth)} |`,
      );
    });
  };
  md.push(`## DEX and regulated venues, by 30-day volume`);
  md.push("");
  table(dex);
  md.push("");
  if (cex.length > 0) {
    md.push(`## Centralised reference`);
    md.push("");
    md.push(
      `Volume, open interest and market counts as the venue reports them to CoinGecko (not an OpenChainBench measurement); funding from the same feed as the DEX rows.`,
    );
    md.push("");
    table(cex);
    md.push("");
  }
  md.push(`## How to read`);
  md.push("");
  md.push(`- Volume and open interest come from each venue's own public API through the perp-cohort-stats harness, every minute; 30-day volume is derived from the 24-hour series when a venue publishes no 30-day figure.`);
  md.push(`- All-in cost is the perp-fees benchmark: taker fee plus half spread plus impact to open a $1,000 ETH long, 24h average. Funding is the perp-funding benchmark, normalised to a 24-hour hold.`);
  md.push(`- Volume over open interest (bench perp-volume-oi-ratio) is the screen for volume that no position backs: ${SITE.url}/benchmarks/perp-volume-oi-ratio`);
  return md.join("\n");
}

export function productMarkdown(p: ProviderProfile): string {
  const md: string[] = [];
  md.push(`# ${p.name}: OpenChainBench measurements`);
  md.push("");
  md.push(`- Page: ${SITE.url}/products/${p.slug}`);
  md.push(`- Live benchmarks: ${distinctBenchCount(p.appearances)}${p.wins > 0 ? `, ${p.wins} first-place ${p.wins === 1 ? "finish" : "finishes"}` : ""}`);
  md.push(`- License: CC-BY-4.0`);
  const runs = p.appearances
    .map((a) => Date.parse(a.benchmark.lastRunAt ?? ""))
    .filter((t) => Number.isFinite(t));
  if (runs.length > 0) md.push(`- Data as of: ${new Date(Math.max(...runs)).toISOString()}`);
  md.push("");
  const ranked = [...p.appearances]
    .filter((a) => a.rank > 0)
    .sort((a, b) => a.rank - b.rank || b.totalRanked - a.totalRanked);
  if (ranked.length > 0) {
    md.push(`## Ranks (p50, 24h unless the bench says otherwise)`);
    md.push("");
    md.push(`| Benchmark | Rank | Value | Page |`);
    md.push(`|---|---|---|---|`);
    for (const a of ranked) {
      md.push(
        `| ${a.benchmark.title} | #${a.rank} of ${a.totalRanked} | ${fmtUnit(a.result.ms.p50, a.benchmark.unit)} | ${SITE.url}/benchmarks/${a.benchmark.slug} |`,
      );
    }
    md.push("");
  }
  const unranked = p.appearances.filter((a) => !(a.rank > 0));
  if (unranked.length > 0) {
    md.push(`## Measured, not ranked`);
    md.push("");
    for (const a of unranked) {
      md.push(`- ${a.benchmark.title}: ${a.result.unrankedLabel ?? "below the ranking floor"} (${SITE.url}/benchmarks/${a.benchmark.slug})`);
    }
    md.push("");
  }
  md.push(`---`);
  md.push(`Every figure is reproducible from public sources; each bench page exposes /api/stat/<slug> with the same values and timestamp.`);
  return md.join("\n");
}

/** Markdown view of /rwa: the five tokenized-RWA benches, leader and
 *  top rows each, in the order the hub shows them. */
export function rwaHubMarkdown(benches: Benchmark[]): string {
  const md: string[] = [];
  md.push(`# Tokenized RWA benchmarks: price, depth, NAV and yield, measured`);
  md.push("");
  md.push(`- Page: ${SITE.url}/rwa`);
  md.push(`- License: CC-BY-4.0`);
  md.push(`- What this is: on-chain reads of what tokenized stocks, treasuries and yield funds do (price against the market, what $100k sells for on Solana, basis to the published NAV, yield delivered against a dated reference, the on-chain supply with and without an open market), not a ranking of declared value.`);
  md.push("");
  for (const b of benches) {
    const insufficient = isInsufficient(b);
    const ranked = insufficient ? [] : rankedCandidates(b);
    md.push(`## ${b.title}`);
    md.push("");
    md.push(`- Page: ${SITE.url}/benchmarks/${b.slug} · JSON: ${SITE.url}/api/stat/${b.slug}`);
    md.push(`- Metric: ${b.metric} (${b.unit}), window ${b.window ?? "24h"}, last sample ${citableAsOf(b) ?? "n/a"}`);
    md.push("");
    md.push(`**Headline.** ${headlineSentence(b)}`);
    md.push("");
    if (ranked.length > 0) {
      md.push(...rankingLines(b, ranked.slice(0, 8)));
      md.push("");
    }
  }
  md.push(`---`);
  md.push(`Every figure is reproducible from public sources; each bench page exposes /api/stat/<slug> with the same values and timestamp.`);
  return md.join("\n");
}



/** Markdown view of /capital: both cohorts, the same rows as the HTML tables. */
export function capitalHubMarkdown(hub: CapitalHub): string {
  const md: string[] = [];
  md.push(`# Capital flows and token valuation leaderboards`);
  md.push("");
  md.push(`- Page: ${SITE.url}/capital`);
  md.push(`- Daily history: https://kv.openchainbench.com/aggregate/valuation/history.json · https://kv.openchainbench.com/aggregate/chains/history.json`);
  md.push(`- JSON per bench: ${hub.benches.map((b) => `${SITE.url}/api/stat/${b.slug}`).join(" · ")}`);
  md.push(`- License: CC-BY-4.0`);
  if (hub.asOf) md.push(`- Data as of: ${hub.asOf}`);
  md.push("");
  if (hub.chains.length > 0) {
    md.push(`## Chains: TVL, bridged value, stablecoin flows`);
    md.push("");
    // Same rule as the table: history-fed columns appear once they carry values.
    const cols: { h: string; v: (c: CapitalHub["chains"][number]) => string }[] = [
      ...(hub.chains.some((c) => c.tvl != null) ? [{ h: "TVL", v: (c: CapitalHub["chains"][number]) => capUsd(c.tvl) }] : []),
      { h: "Bridged value", v: (c) => capUsd(c.bridgedTvl) },
      { h: "7d vs L2 peers", v: (c) => capPct(c.excess7dPct) },
      { h: "Stablecoin float", v: (c) => capUsd(c.stablesFloat) },
      { h: "Net stables 30d", v: (c) => capUsd(c.stablesNet30d) },
      ...(hub.chains.some((c) => c.cctpNet7d != null) ? [{ h: "USDC over CCTP 7d", v: (c: CapitalHub["chains"][number]) => capUsd(c.cctpNet7d) }] : []),
      ...(hub.chains.some((c) => c.dexVolume24h != null) ? [{ h: "DEX volume 24h", v: (c: CapitalHub["chains"][number]) => capUsd(c.dexVolume24h) }] : []),
      ...(hub.chains.some((c) => c.fees30d != null) ? [{ h: "Fees 30d", v: (c: CapitalHub["chains"][number]) => capUsd(c.fees30d) }] : []),
      { h: "Reading", v: (c) => c.note },
    ];
    md.push(`| # | Chain | ${cols.map((c) => c.h).join(" | ")} |`);
    md.push(`|---|---|${cols.map(() => "---").join("|")}|`);
    hub.chains.forEach((c, i) => {
      md.push(`| ${i + 1} | ${c.name} | ${cols.map((k) => k.v(c)).join(" | ")} |`);
    });
    md.push("");
  }
  if (hub.pmOi.length > 0 || hub.perpOi.length > 0) {
    md.push(`## Open interest`);
    md.push("");
    if (hub.perpOi.length > 0) md.push(`Perp DEXes: ${hub.perpOi.slice(0, 8).map((r) => `${r.name} ${capUsd(r.oi)}`).join(", ")}.`);
    if (hub.pmOi.length > 0) md.push(`Prediction markets: ${hub.pmOi.slice(0, 8).map((r) => `${r.name} ${capUsd(r.oi)}`).join(", ")}.`);
    md.push("");
  }
  if (hub.protocols.length > 0) {
    md.push(`## Tokens by price to fees (market cap over annualized 30-day fees)`);
    md.push("");
    md.push(`| # | Token | Category | P/F | FDV/F | Float | Fees MoM | Token 30d | vs category median | Reading |`);
    md.push(`|---|---|---|---|---|---|---|---|---|---|`);
    hub.protocols.forEach((p, i) => {
      const flag = p.signal === "fees-up-token-down" ? " (fees up, token down)" : p.signal === "fees-down-token-up" ? " (fees down, token up)" : "";
      md.push(
        `| ${i + 1} | ${p.name} | ${p.category || "n/a"} | ${capX(p.pf)} | ${capX(p.pfFdv)} | ${p.floatPct != null ? p.floatPct.toFixed(0) + "%" : "n/a"} | ${capPct(p.feeGrowth30dPct, 0)} | ${capPct(p.priceChange30dPct, 0)} | ${capX(p.pfVsCategory)}${flag} | ${p.note} |`,
      );
    });
    md.push("");
  }
  if (hub.perps.length > 0) {
    md.push(`## Perp DEX tokens: P/F, P/S, FDV, float, open interest`);
    md.push("");
    md.push(`| # | Venue | P/F | P/S | FDV/F | Market cap | FDV | Float | Open interest | Fees 30d | Revenue 30d |`);
    md.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
    hub.perps.forEach((p, i) => {
      md.push(
        `| ${i + 1} | ${p.name} | ${capX(p.pf)} | ${capX(p.ps)} | ${capX(p.pfFdv)} | ${capUsd(p.mcap)} | ${capUsd(p.fdv)} | ${p.floatPct != null ? p.floatPct.toFixed(0) + "%" : "n/a"} | ${capUsd(p.oi)} | ${capUsd(p.fees30d)} | ${capUsd(p.rev30d)} |`,
      );
    });
    md.push("");
  }
  md.push(`Sources: DeFiLlama (fees, revenue, TVL, DEX volume, stablecoins), L2Beat (value secured), CoinGecko (market data), Polymarket and Kalshi (open interest). Not measured: token unlock schedules, bridge volumes beyond what OpenChainBench reads itself.`);
  return md.join("\n");
}
