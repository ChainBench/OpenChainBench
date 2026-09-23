import type { Benchmark } from "@/types/benchmark";
import { citableAsOf, isInsufficient, leaders, rankedCandidates } from "@/lib/citation";

/**
 * The /rwa hub's data join. Six benches measure the same assets from
 * different sides (a tokenized stock on Robinhood Chain and on Solana, its
 * weekend drift, what $100k of it sells for, its on-chain supply; a
 * treasury token's delivered yield, its NAV basis, its depth). The hub
 * shows one row per asset with a column per bench, so every cell here is
 * read from a bench under that bench's own gate: a value appears only
 * when the bench ranks the row (or, for a companion panel, publishes it).
 */

export const RWA_BENCH_SLUGS = [
  "rwa-yield-accuracy",
  "usdy-nav-basis",
  "tokenized-stock-peg",
  "xstocks-peg",
  "tokenized-stock-weekend-drift",
  "rwa-solana-depth",
] as const;

export type RwaBenches = Record<string, Benchmark | null>;

/** Headline value (p50, in the bench's unit) for a row the bench ranks;
 *  null when the bench asserts nothing or the row is not ranked. */
export function rankedValue(b: Benchmark | null | undefined, slug: string): number | null {
  if (!b || isInsufficient(b)) return null;
  const r = rankedCandidates(b).find((x) => x.slug === slug);
  return r && Number.isFinite(r.ms.p50) ? r.ms.p50 : null;
}

/** A slot other than p50 (mean, p99) for a ranked row. */
export function rankedSlot(b: Benchmark | null | undefined, slug: string, slot: "mean" | "p90" | "p99"): number | null {
  if (!b || isInsufficient(b)) return null;
  const r = rankedCandidates(b).find((x) => x.slug === slug);
  const v = r?.ms[slot];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A companion panel's value for a row, ranked or not (an unranked
 *  "No open market" row still publishes its on-chain supply). */
export function panelValue(b: Benchmark | null | undefined, panelId: string, slug: string): number | null {
  const v = b?.metricPanels?.find((p) => p.id === panelId)?.values?.[slug];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The unranked label a spec gives a row ("No open market"), if any. */
export function unrankedLabel(b: Benchmark | null | undefined, slug: string): string | null {
  return b?.results.find((r) => r.slug === slug)?.unrankedLabel ?? null;
}

export type StockRow = {
  slug: string;
  ticker: string;
  /** Robinhood Chain pool vs Nasdaq, regular hours, 7d median (bp). */
  robinhood: number | null;
  /** xStocks on Solana vs Nasdaq, regular hours, 7d median (bp). */
  xstocks: number | null;
  /** Last weekend's maximum drift from Friday close, Robinhood Chain (bp). */
  weekend: number | null;
  /** Cost of a $100k sale of the xStock on Jupiter, 24h median (bp). */
  cost100k: number | null;
  /** On-chain supply of the xStock on Solana, USD. */
  supplyUsd: number | null;
};

const STOCK_BENCHES = ["tokenized-stock-peg", "xstocks-peg"] as const;

export function stockRows(benches: RwaBenches): StockRow[] {
  const slugs = new Set<string>();
  for (const s of STOCK_BENCHES) for (const r of benches[s]?.results ?? []) slugs.add(r.slug);
  const rows: StockRow[] = [...slugs].map((slug) => ({
    slug,
    ticker: slug.toUpperCase(),
    robinhood: rankedValue(benches["tokenized-stock-peg"], slug),
    xstocks: rankedValue(benches["xstocks-peg"], slug),
    weekend: rankedValue(benches["tokenized-stock-weekend-drift"], slug),
    cost100k: rankedValue(benches["rwa-solana-depth"], slug),
    supplyUsd: panelValue(benches["rwa-solana-depth"], "supply", slug),
  }));
  const best = (r: StockRow) => {
    const xs = [r.robinhood, r.xstocks].filter((v): v is number => v != null);
    return xs.length > 0 ? Math.min(...xs) : Number.POSITIVE_INFINITY;
  };
  return rows
    .filter((r) => r.robinhood != null || r.xstocks != null)
    .sort((a, b) => best(a) - best(b) || a.ticker.localeCompare(b.ticker));
}

export type FundRow = {
  slug: string;
  name: string;
  issuer: string;
  kind: "treasury" | "credit" | "gold";
  /** Annualized yield accrued on-chain over 30d (bp). */
  delivered: number | null;
  /** Dated 30-day reference APY (bp). */
  reference: number | null;
  /** Delivered minus reference, 30d, signed (bp). */
  gap: number | null;
  /** Median absolute basis of the closest venue to the published NAV (bp); USDY only. */
  navBasis: number | null;
  /** Cost of a $100k sale on Solana, 24h median (bp). */
  cost100k: number | null;
  /** "No open market" when the depth bench lists the row unranked. */
  noMarket: string | null;
  supplyUsd: number | null;
  supplyUnits: number | null;
};

const FUNDS: { slug: string; name: string; issuer: string; kind: FundRow["kind"] }[] = [
  { slug: "usdy", name: "USDY", issuer: "Ondo", kind: "treasury" },
  { slug: "ousg", name: "OUSG", issuer: "Ondo", kind: "treasury" },
  { slug: "ustb", name: "USTB", issuer: "Superstate", kind: "treasury" },
  { slug: "buidl", name: "BUIDL", issuer: "BlackRock", kind: "treasury" },
  { slug: "syrup-usdc", name: "SyrupUSDC", issuer: "Maple", kind: "credit" },
  { slug: "paxg", name: "PAXG", issuer: "Paxos", kind: "gold" },
];

export function fundRows(benches: RwaBenches): FundRow[] {
  const yieldB = benches["rwa-yield-accuracy"];
  const depth = benches["rwa-solana-depth"];
  const nav = benches["usdy-nav-basis"];
  const navLead = nav && !isInsufficient(nav) ? leaders(nav)[0] : undefined;
  return FUNDS.map((f) => ({
    ...f,
    delivered: rankedSlot(yieldB, f.slug, "mean"),
    reference: rankedValue(yieldB, f.slug) == null ? null : panelValue(yieldB, "promised", f.slug),
    gap: rankedSlot(yieldB, f.slug, "p99"),
    navBasis: f.slug === "usdy" && navLead ? navLead.value : null,
    cost100k: rankedValue(depth, f.slug),
    noMarket: unrankedLabel(depth, f.slug),
    supplyUsd: panelValue(depth, "supply", f.slug),
    supplyUnits: panelValue(depth, "supply_units", f.slug),
  })).filter((r) => r.delivered != null || r.cost100k != null || r.noMarket || r.supplyUsd != null);
}

export type RwaTotals = {
  /** Sum of the on-chain supply of the rows in the total's row set, USD. */
  measuredUsd: number;
  /** Supply of the assets whose $100k sale costs 25 bp or less. */
  liquidUsd: number;
  /** Supply of the assets the depth bench lists as No open market. */
  noMarketUsd: number;
  /** False when a routed asset with a supply has no ranked cost right now:
   *  the liquid share is then unknown, not zero. */
  liquidKnown: boolean;
  assets: number;
};

export const LIQUID_BPS = 25;

/**
 * The three totals are sums over one row set: the routed rows the depth
 * bench ranks right now plus its declared unranked rows. A routed row the
 * bench does not rank (route failing, sample under the floor) is in none
 * of them, and marks the liquid share unknown, so a Jupiter outage reads
 * as "…" and never as "$0 sells $100k" against a held supply (review
 * 2026-09-23).
 */
export function totals(benches: RwaBenches): RwaTotals {
  const depth = benches["rwa-solana-depth"];
  let measuredUsd = 0;
  let liquidUsd = 0;
  let noMarketUsd = 0;
  let liquidKnown = true;
  for (const r of depth?.results ?? []) {
    const usd = panelValue(depth, "supply", r.slug);
    if (usd == null) continue;
    if (r.unrankedLabel) {
      measuredUsd += usd;
      noMarketUsd += usd;
      continue;
    }
    const cost = rankedValue(depth, r.slug);
    if (cost == null) {
      liquidKnown = false;
      continue;
    }
    measuredUsd += usd;
    if (cost <= LIQUID_BPS) liquidUsd += usd;
  }
  const assets = new Set<string>();
  for (const s of RWA_BENCH_SLUGS) for (const r of benches[s]?.results ?? []) assets.add(r.slug);
  // Venues of the NAV bench are not assets.
  for (const r of benches["usdy-nav-basis"]?.results ?? []) assets.delete(r.slug);
  return { measuredUsd, liquidUsd, noMarketUsd, liquidKnown, assets: assets.size };
}

/** Newest citable timestamp across the live benches. */
export function hubAsOf(benches: RwaBenches): string | null {
  return (
    RWA_BENCH_SLUGS.map((s) => benches[s])
      .filter((b): b is Benchmark => !!b && !isInsufficient(b))
      .map((b) => citableAsOf(b))
      .filter((x): x is string => !!x)
      .sort()
      .at(-1) ?? null
  );
}
