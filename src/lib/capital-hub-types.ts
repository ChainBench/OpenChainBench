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
} as const;

export type ChainRow = {
  slug: string;
  name: string;
  tvl: number | null;
  /** Ranked by bench 273 (L2Beat cohort); false for L1s, where bridged columns do not apply. */
  inBridgedCohort: boolean;
  /** Ranked by bench 275 (stablecoin cohort above $100M of float). */
  inStablesCohort: boolean;
  bridgedTvl: number | null;
  bridgedSharePct: number | null;
  change7dPct: number | null;
  excess7dPct: number | null;
  stablesFloat: number | null;
  stablesNet30d: number | null;
  stablesChange30dPct: number | null;
  stablesNet7d: number | null;
  /** Net USDC that entered the chain over Circle CCTP in 7 days (bench 281), null off the scanned set. */
  cctpNet7d: number | null;
  cctpIn7d: number | null;
  cctpOut7d: number | null;
  dexVolume24h: number | null;
  nativeMcap: number | null;
  fees30d: number | null;
  revenue30d: number | null;
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

export type OiRow = { slug: string; name: string; oi: number; volume24h: number | null; turnover: number | null };

export type FlowShare = { slug: string; name: string; usd: number; pct: number };

export type CapitalHub = {
  /** Newest lastRunAt across the benches that loaded, ISO. */
  asOf: string | null;
  benches: { slug: string; title: string; live: boolean }[];
  chains: ChainRow[];
  stableFlowShares: FlowShare[];
  perpOi: OiRow[];
  pmOi: OiRow[];
  protocols: ProtocolRow[];
  perps: PerpRow[];
  leaders: {
    bridgedTvl: ChainRow | null;
    stableInflow: ChainRow | null;
    lowestPfProtocol: ProtocolRow | null;
    lowestPfPerp: PerpRow | null;
    pmOi: OiRow | null;
  };
  /** True when the daily history blobs carry at least two days. */
  historyDays: number;
};

export function fmtUsdShort(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  const abs = Math.abs(v);
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
