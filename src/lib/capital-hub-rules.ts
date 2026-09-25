/**
 * Pure display and selection rules of the /capital hub, shared by the
 * server loader (capital-hub.ts), the client tables (capital-hub-tabs.tsx),
 * the Markdown view and the JSON endpoint, so every surface applies one
 * rule and the tests exercise the rule once. No server imports.
 */

import { fmtPct, fmtUsdShort } from "@/lib/capital-hub-types";

/* ---------------------------------------------------------------- dust */

/**
 * DeFiLlama answers 0 (or a few dollars) for a chain it does not track, so
 * a level under this floor is not a measurement of the chain: it renders as
 * a muted "<$1K" and sorts as 0. Levels only (TVL, float, DEX volume, fees,
 * revenue); a flow keeps its sign and its digits, a bridged value comes from
 * L2Beat, which lists nothing it does not track.
 */
export const DUST_USD = 1_000;

export function isDust(v: number | null): boolean {
  return v != null && Number.isFinite(v) && Math.abs(v) < DUST_USD;
}

/** A USD level for the tables: n/a when missing, "<$1K" under the dust floor. */
export function fmtUsdLevel(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return isDust(v) ? "<$1K" : fmtUsdShort(v);
}

/** Sort key of a level: dust sorts as 0 so "<$1K" never outranks a real value. */
export function levelSortValue(v: number | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return isDust(v) ? 0 : v;
}

/* ------------------------------------------------------- 7d vs median */

/**
 * Bench 273 publishes the chain's 7d move and its excess over the cohort
 * median (chain_tvs_change_7d_excess_pct); the median itself is a no-label
 * gauge the bench does not carry per row, so it is recovered as move minus
 * excess.
 */
export function median7dPct(change7dPct: number | null, excess7dPct: number | null): number | null {
  if (change7dPct == null || excess7dPct == null) return null;
  if (!Number.isFinite(change7dPct) || !Number.isFinite(excess7dPct)) return null;
  return change7dPct - excess7dPct;
}

/** The sub-line under "7d vs L2 median": `chain +8.7%, median +4.7%`, or null when either side is missing. */
export function sevenDaySubline(change7dPct: number | null, medianPct: number | null): string | null {
  if (change7dPct == null || medianPct == null) return null;
  return `chain ${fmtPct(change7dPct)}, median ${fmtPct(medianPct)}`;
}

/* ----------------------------------------------------- bridged share */

/** "NN% bridged" only when it says something: a share at or above 90% is the normal case for an L2 and is left out. */
export function bridgedShareSubline(sharePct: number | null): string | null {
  if (sharePct == null || !Number.isFinite(sharePct)) return null;
  return sharePct < 90 ? `${sharePct.toFixed(0)}% bridged` : null;
}

/* ------------------------------------------------ cohort-gated cells */

/**
 * One cell of a bench-ranked column (Net stables 30d on bench 275, Fees
 * and Revenue 30d on bench 280):
 *  - value: the chain is in the bench's cohort (or the bench did not load,
 *    so membership is unknown) and the bench carries a value;
 *  - na: in the cohort, no value (a withheld row or a transient outage);
 *  - outside: the bench loaded, the chain is not in its cohort, and the
 *    history blob still has a value for it: shown muted, never ranked,
 *    counted or crowned;
 *  - dash: outside the cohort and no data source at all.
 */
export type CohortCell =
  | { kind: "value"; value: number }
  | { kind: "na" }
  | { kind: "outside"; value: number }
  | { kind: "dash" };

export const OUTSIDE_COHORT_LABEL = "outside the ranked cohort";

export function cohortCell(inCohort: boolean, ranked: number | null, outside: number | null): CohortCell {
  if (inCohort) return ranked != null && Number.isFinite(ranked) ? { kind: "value", value: ranked } : { kind: "na" };
  if (outside != null && Number.isFinite(outside)) return { kind: "outside", value: outside };
  return { kind: "dash" };
}

/* ------------------------------------------------------------- CCTP */

/**
 * Chains with a Circle CCTP domain, as OpenChainBench slugs, from the
 * bridge-flows harness table (harnesses/bridge-flows/cmd/script/config.go,
 * Circle's supported-blockchains page read 2026-09-25). The harness slug
 * "hyperevm" is the registry's "hyperliquid". A chain outside this set has
 * no CCTP corridor at all and reads a dash; a chain inside it that bench 281
 * does not scan as a source reads a dash too, with its own label; only a
 * scanned chain can read n/a.
 */
export const CCTP_DOMAIN_CHAINS: ReadonlySet<string> = new Set([
  "ethereum",
  "avalanche",
  "optimism",
  "arbitrum",
  "noble",
  "solana",
  "base",
  "polygon",
  "sui",
  "aptos",
  "unichain",
  "linea",
  "codex",
  "sonic",
  "world-chain",
  "monad",
  "sei",
  "bnb",
  "xdc",
  "hyperevm",
  "hyperliquid",
  "ink",
  "plume",
  "starknet",
  "arc",
  "stellar",
  "edge",
  "injective",
  "morph",
  "pharos",
  "cronos",
  "plasma",
  "xlayer",
]);

export type CctpScope = "scanned" | "domain" | "none";

export function cctpScope(slug: string, scanned: ReadonlySet<string>): CctpScope {
  if (scanned.has(slug)) return "scanned";
  return CCTP_DOMAIN_CHAINS.has(slug) ? "domain" : "none";
}

export const CCTP_SCOPE_LABEL: Record<Exclude<CctpScope, "scanned">, string> = {
  none: "no CCTP domain",
  domain: "CCTP domain, not scanned as a source",
};

/* ------------------------------------------------------ divergences */

export type DivergenceCandidate = {
  feeGrowth30dPct: number | null;
  priceChange30dPct: number | null;
  pfVsCategory: number | null;
};

/**
 * The harness's protocol_diverging rule: fees up month over month, token
 * down over 30 days, P/F under the category median, all three at once.
 * The block on the tokens tab shows the five with the largest fee growth.
 */
export function isDiverging(r: DivergenceCandidate): boolean {
  return (
    r.feeGrowth30dPct != null &&
    r.priceChange30dPct != null &&
    r.pfVsCategory != null &&
    r.feeGrowth30dPct > 0 &&
    r.priceChange30dPct < 0 &&
    r.pfVsCategory < 1
  );
}

export function selectDivergences<T extends DivergenceCandidate>(rows: T[], limit = 5): T[] {
  return rows
    .filter(isDiverging)
    .sort((a, b) => (b.feeGrowth30dPct ?? 0) - (a.feeGrowth30dPct ?? 0))
    .slice(0, limit);
}

/* ------------------------------------------------------- 7d change */

/**
 * Percent change between the newest point and the point seven days before
 * it in a daily history (the valuation blob's `oi` per perp). Null until
 * the blob holds that older day: no shorter window is passed off as 7d.
 */
export function change7dFromDays(days: { day: string; [k: string]: unknown }[], field: string): number | null {
  if (days.length === 0) return null;
  const last = days[days.length - 1];
  const lastV = last[field];
  if (typeof lastV !== "number" || !Number.isFinite(lastV)) return null;
  const t = Date.parse(`${last.day}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  const target = new Date(t - 7 * 86_400_000).toISOString().slice(0, 10);
  const before = days.find((d) => d.day === target);
  const beforeV = before?.[field];
  if (typeof beforeV !== "number" || !Number.isFinite(beforeV) || beforeV <= 0) return null;
  return ((lastV - beforeV) / beforeV) * 100;
}

/**
 * Same change off a bench's 7d series (84 buckets over seven days): the
 * first and last finite buckets, and only when the series covers most of
 * the window (first finite bucket inside the first quarter), so a bench
 * that started yesterday does not publish a one-day move as 7d.
 */
export function change7dFromSeries(series: (number | null)[] | undefined): number | null {
  if (!series || series.length < 4) return null;
  const firstIdx = series.findIndex((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
  if (firstIdx < 0 || firstIdx > Math.floor(series.length / 4)) return null;
  let lastIdx = -1;
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (typeof v === "number" && Number.isFinite(v)) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx <= firstIdx) return null;
  const a = series[firstIdx] as number;
  const b = series[lastIdx] as number;
  return ((b - a) / a) * 100;
}

/* --------------------------------------------------- reading notes */

/**
 * Three sentences under each table: how to read the main column, the
 * pitfall, what the table does not say. Plain statements, no verdicts.
 * The Markdown view prints the same lines.
 */
export const CAPITAL_READING = {
  chains: [
    "TVL is the value locked in DeFi contracts on the chain today, a level in dollars; the rank follows it, then stablecoin float, then bridged value when a chain has neither.",
    "TVL is DeFiLlama's DeFi TVL and bridged value is L2Beat's value secured, two different measures of two different things; a chain can rank high on one and low on the other. Net stables 30d is a flow and carries a sign, the other columns are levels and do not. Values under $1K are DeFiLlama zeros for chains it does not track, not measured amounts.",
    "The table does not say where the capital came from or whether it stays: a stablecoin inflow can be one issuer's mint, a bridged value can move with the price of the assets locked, and an L1 has no bridged value to report.",
  ],
  tokens: [
    "P/F is market cap over the last 30 days of protocol fees annualized; the column to read it against is vs category, the P/F divided by the fee-weighted median of the token's category, below 1 meaning under that median.",
    "A P/F on an incomplete fee adapter is unranked and absent here, a float under 10% is held out too, and one month of fees is one month: Fees MoM can swing on a single incentive program.",
    "The table does not say whether a multiple should be higher or lower: it does not see token emissions ahead, buybacks, fee switches or where the fees go, only what the market paid per dollar of fees on the day.",
  ],
  perps: [
    "P/F is market cap over annualized trading fees and P/S the same over the protocol's own share of those fees; the gap between the two is the share paid out to liquidity providers and referrers.",
    "Fees 30d and open interest exist for a venue with no token, P/F does not: a pre-launch venue is listed on the bench unranked and is absent here. FDV/F prices unvested supply as already trading, so a low float widens it against P/F.",
    "The table does not say how the fees were earned: incentivized or wash volume counts the same as organic volume in the fee line, and open interest is a level at one instant.",
  ],
  openInterest: [
    "Open interest is the notional of positions open at the last read, for perp DEXes from each venue's API through bench 265 and for prediction markets from Polymarket, Kalshi and the venues' own endpoints through bench 277.",
    "A level, not a flow: two venues can hold the same open interest with very different daily volume, and a prediction market's open interest is the value of unresolved contracts, not margin. The 7d column appears only where seven days of daily history exist.",
    "The table does not say who holds the positions, how leveraged they are, or how much of the open interest is one market or one wallet.",
  ],
} as const;
