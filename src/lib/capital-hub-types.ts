import { fmtUnit } from "@/lib/format";

/**
 * Client-safe part of the capital hub: bench slugs, row types and the
 * formatters the tables and the markdown view share. No server imports
 * here, so the client tabs component can pull it without dragging the
 * benchmark loader into the browser bundle.
 */

export const CAPITAL_BENCHES = {
  bridgedTvl: "chain-bridged-tvl",
  stableFlow: "chain-stablecoin-flow",
  protocolPf: "protocol-pf-ratio",
  perpPf: "perp-pf-ratio",
  pmOi: "pm-open-interest",
  /** Bench 281, dev-only for now: net USDC over Circle CCTP among seven EVM chains. */
  usdcCorridor: "usdc-corridor-flows",
  /** Bench 280, dev-only for now: fees paid on the chain over 30 days, with the revenue kept; the hub reads its
   *  cohort so a chain the bench does not rank shows its blob value muted instead of in the ranked column. */
  chainFees: "chain-fees-revenue",
  /** Bench 271: 24h volume over the venue's own open interest, the turnover column of the perp open-interest table.
   *  Read from the bench rather than divided out of the two columns next to it, because the bench divides 24-hour
   *  averages of the two gauges and the table shows the latest read: one named ratio must not have two values. */
  perpTurnover: "perp-volume-oi-ratio",
} as const;

export type ChainRow = {
  slug: string;
  name: string;
  tvl: number | null;
  /** Member of bench 273's provider list (L2Beat cohort, unavailable and unranked rows included). False only when
   *  the bench loaded and the chain is not in it (an L1), so the bridged columns read "not applicable" with the
   *  reason; true when the bench failed to load, so a transient outage reads unknown and never "not applicable". */
  inBridgedCohort: boolean;
  /** Same rule for bench 275's provider list (stablecoin cohort above $100M of float). */
  inStablesCohort: boolean;
  /** Same rule for bench 280's provider list (chain fees cohort); true whenever that bench is not loaded. */
  inFeesCohort: boolean;
  bridgedTvl: number | null;
  bridgedSharePct: number | null;
  change7dPct: number | null;
  excess7dPct: number | null;
  /** Median 7d move of the L2Beat cohort above $200M: the chain's move minus its excess (bench 273). */
  median7dPct: number | null;
  stablesFloat: number | null;
  /** Ranked net flow from bench 275 only: the leader, the counts, the FAQ and the inflow bar read this field. */
  stablesNet30d: number | null;
  /** The history blob's net flow for a chain outside bench 275's cohort: shown muted, never ranked or counted. */
  stablesNet30dOutside: number | null;
  stablesChange30dPct: number | null;
  stablesNet7d: number | null;
  /** Where the chain stands on bench 281: scanned as a CCTP source, a CCTP domain the bench does not scan, or no
   *  domain at all. Only a scanned chain can read unknown; the other two are "not applicable" with their own reason. */
  cctpScope: "scanned" | "domain" | "none";
  /** Net USDC that entered the chain over Circle CCTP in 7 days (bench 281), null off the scanned set. */
  cctpNet7d: number | null;
  cctpIn7d: number | null;
  cctpOut7d: number | null;
  dexVolume24h: number | null;
  nativeMcap: number | null;
  /** Chain fees over 30 closed days from bench 280's ranked rows only (headline p50); null for a listed but
   *  unranked chain and whenever the bench did not load, so the cell reads unknown. */
  fees30d: number | null;
  /** Revenue kept out of those fees, bench 280's revenue_30d panel, same gating. */
  revenue30d: number | null;
  /** The history blob's series for a chain outside bench 280's cohort: shown muted, never ranked. */
  fees30dOutside: number | null;
  revenue30dOutside: number | null;
  /** Why a column has no value for this chain and never will, keyed by column (src/lib/capital-hub-rules.ts
   *  NA_REASON). A key is absent when the column is ranked, muted, or missing for a reason the hub does not
   *  know, which reads as unknown rather than as not applicable. `cctp` has no column on the page since the
   *  CCTP reading moved to its own block over the seven scanned chains; it is kept here because it answers
   *  the same question for a consumer of /api/capital, in words. */
  notApplicable: {
    bridged?: string;
    stables?: string;
    fees?: string;
    cctp?: string;
  };
  hasChainPage: boolean;
};

export type ProtocolRow = {
  slug: string;
  name: string;
  category: string;
  pf: number | null;
  pfFdv: number | null;
  floatPct: number | null;
  feeGrowth30dPct: number | null;
  priceChange30dPct: number | null;
  pfVsCategory: number | null;
  categoryMedianPf: number | null;
  fees30d: number | null;
  /** DeFi TVL of the protocol (protocol_tvl_usd, blob `tvl`); null until the harness publishes it. */
  tvl: number | null;
  /** Revenue kept by the protocol over 30 days (protocol_revenue_30d_usd, blob `rev_30d`). */
  revenue30d: number | null;
  /** 1 when the revenue total is knowably short (protocol_revenue_incomplete, blob `revenue_incomplete`): shown muted, never a P/S. */
  revenueIncomplete: boolean;
  /** Market cap over annualized revenue (protocol_ps_ratio, blob `ps`). */
  ps: number | null;
  /** Realized dilution: circulating supply change over 30 days (protocol_supply_change_30d_pct, blob `supply_change_30d_pct`). */
  supplyChange30dPct: number | null;
  /** Ranked protocols in the same category on this board, the number the reader can count in the table. */
  categorySize: number;
  /** Why the vs-category cell carries no ratio: the category is too small for its median to be a peer comparison. */
  pfVsCategoryNaReason: string | null;
  signal: "fees-up-token-down" | "fees-down-token-up" | null;
  hasProductPage: boolean;
};

export type PerpRow = {
  slug: string;
  name: string;
  pf: number | null;
  ps: number | null;
  pfFdv: number | null;
  mcap: number | null;
  fdv: number | null;
  floatPct: number | null;
  oi: number | null;
  fees30d: number | null;
  rev30d: number | null;
  hasProductPage: boolean;
};

export type OiRow = {
  slug: string;
  name: string;
  /** Open interest: bench 277 for prediction markets, each venue's own API through the perp cohort harness for perp
   *  DEXes. Null for a venue the harness gets no open interest from, which is a row on the table with a reason, not
   *  a row left off it. */
  oi: number | null;
  /** Why open interest is absent for this row (the venue publishes none), null when the value is simply missing. */
  oiNaReason: string | null;
  /** 24h traded notional: bench 277 for prediction markets, the perp cohort harness for perp DEXes. */
  volume24h: number | null;
  /** 24h volume over open interest: bench 277's panel for prediction markets, bench 271's headline for perp DEXes. */
  turnover: number | null;
  /** Change of open interest over seven days, from the daily history or the bench's 7d series; null where neither covers seven days. */
  change7dPct: number | null;
  /** Why the 7d cell has no number and will not get one from this series (warm-up, one reading, a step in what the venue reports). */
  change7dNaReason: string | null;
  /** Why the volume cell has no number: the venue is outside the volume cohort. Null when the value is simply missing. */
  volumeNaReason: string | null;
  /** Why the turnover cell has no number: the venue publishes no open interest to the cohort harness. */
  turnoverNaReason: string | null;
};

export type FlowShare = { slug: string; name: string; usd: number; pct: number };

export type CapitalHub = {
  /** Newest lastRunAt across the benches that loaded, ISO. */
  asOf: string | null;
  /** live: served and ranked on this deployment; failed: the load threw or the blob was unreadable (a transient state, not "unpublished"). */
  benches: { slug: string; title: string; live: boolean; failed: boolean }[];
  chains: ChainRow[];
  stableFlowShares: FlowShare[];
  perpOi: OiRow[];
  pmOi: OiRow[];
  protocols: ProtocolRow[];
  /** The protocol_diverging rows (fees up, token down, P/F under the category median), five largest fee growth first. */
  divergences: ProtocolRow[];
  perps: PerpRow[];
  leaders: {
    bridgedTvl: ChainRow | null;
    /** Every chain whose bridged value rounds to the leader's at display precision (the bench's tie rule); length 1 when there is a single leader. */
    bridgedTvlTied: ChainRow[];
    stableInflow: ChainRow | null;
    lowestPfProtocol: ProtocolRow | null;
    lowestPfPerp: PerpRow | null;
    pmOi: OiRow | null;
  };
  /** True when the daily history blobs carry at least two days. */
  historyDays: number;
  /** False when the perp venue cohort snapshot did not answer this render. The perp open-interest table has no
   *  rows then, and the page says so rather than letting the table vanish without a reason: a missing table is
   *  the same defect as a missing cell, one level up. Never a reason to fall back to another measurement. */
  perpVenueCohortLive: boolean;
};

export function fmtUsdShort(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  const abs = Math.abs(v);
  // A flow of forty cents rounds to zero and prints without a sign: never "-$0".
  if (abs < 0.5) return "$0";
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function fmtPct(v: number | null, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/** Same digits as the bench pages, /api/stat and the answers (fmtUnit "x"), so one entity never prints two ratios. */
export function fmtX(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return fmtUnit(v, "x");
}
