import { getBenchmark } from "@/data/benchmarks";
import { isDevOnlyBench } from "@/lib/removed-benches";
import type { ProviderResult } from "@/types/benchmark";

/**
 * Trading-app cohort shared by the /trading-apps hub and the "Trading
 * app" view on /products/<slug>: the platforms, the KPI columns and the
 * bench each column reads, plus one loader that returns every platform's
 * row with its rank per column so both surfaces show the same numbers.
 *
 * Which columns exist depends on the deployment. TRADING_APP_COLUMNS drops
 * any column whose bench this deployment does not serve, so a gated bench
 * takes its column with it instead of leaving a stripe of dashes. On
 * production since 2026-09-27 that removes swap transactions, average
 * trade, active wallets and the Dune fee rate, because the Dune trial
 * ended and those four benches stood down; the commission and take rate
 * from bench 201 arrive in their place, from DeFiLlama's free adapters.
 *
 * Volume itself is not a column here: it lives in bench 267's table above,
 * so one app has one volume figure per page. Terminal (slug: padre) is
 * pump.fun's own trading app, formerly Padre.
 */

export const TRADING_APP_PLATFORMS = [
  { slug: "pump-fun", name: "pump.fun" },
  { slug: "padre", name: "Terminal" },
  { slug: "gmgn", name: "GMGN" },
  { slug: "axiom", name: "Axiom" },
  { slug: "fomo", name: "FOMO" },
  { slug: "trojan", name: "Trojan" },
  { slug: "photon", name: "Photon" },
  { slug: "maestro", name: "Maestro" },
  { slug: "basedbot", name: "BasedBot" },
] as const;

export const TRADING_APP_SLUGS: ReadonlySet<string> = new Set(
  TRADING_APP_PLATFORMS.map((p) => p.slug),
);

export type TradingAppColKey =
  | "traders"
  | "tradeSize"
  | "wallets"
  | "feeRate"
  | "commission"
  | "takeRate"
  | "rating";

export type TradingAppColumn = {
  key: TradingAppColKey;
  label: string;
  bench: string;
  /** How wide this column's figures are, stated by the column rather than read
   *  out of its spec prose. "app" means each row covers whatever its own
   *  adapter covers, which the Chains cell on the same row already shows, so no
   *  cell carries a badge. "solana" means every figure in the column is Solana
   *  only and the column says so once, in its header. Guessing this from the
   *  formula text badged GMGN's commission "Solana only" because its formula
   *  happens to contain the word, while the harness sums ten chains. */
  scope: "app" | "solana";
  /** Metric-panel id to read instead of the bench's headline value. When set,
   *  the ranking direction comes from the panel itself, so the spec and the
   *  hub cannot disagree about which end of the column is better. */
  panel?: string;
  fmt: (v: number | null) => string;
  tip: string;
  higherBetter: boolean;
};

/** Every column, whatever this deployment serves. Staging shows all of them. */
export const ALL_TRADING_APP_COLUMNS: readonly TradingAppColumn[] = [
  {
    key: "traders",
    label: "Swap Tx",
    scope: "app",
    bench: "solana-unique-traders",
    fmt: fmtCount,
    tip: "Unique swap transactions in 24h via Dune. pump.fun uses dex_solana.trades (all swaps incl. 0-fee). Terminals use fee-wallet detection (fee-generating swaps only). Methods differ.",
    higherBetter: true,
  },
  {
    key: "tradeSize",
    label: "Avg Trade",
    scope: "app",
    bench: "solana-avg-trade-size",
    fmt: fmtUSD,
    tip: "24h volume ÷ trade count via Mobula. Includes bots and MEV — platforms with heavy bot sniping (notably pump.fun) show lower averages than human-only baselines.",
    higherBetter: true,
  },
  {
    key: "wallets",
    label: "Active Wallets",
    scope: "app",
    bench: "trading-platform-wallets",
    fmt: fmtCount,
    tip: "Unique wallets that traded through the platform in the last complete day (Dune community datasets). Cross-chain for GMGN/Axiom/BasedBot/Terminal, Solana only for FOMO/Trojan/Photon (marked SOL). Better signal of real user base than raw tx count.",
    higherBetter: true,
  },
  {
    key: "feeRate",
    label: "Fee Rate",
    scope: "app",
    bench: "memecoin-platforms",
    fmt: fmtPct,
    tip: "Observed take rate: fee revenue ÷ fee-paying volume (Dune tx join). Comparable across platforms. FOMO uses DeFiLlama (includes off-chain relay fees). pump.fun cut trading fees to 0% in Aug 2026.",
    higherBetter: false,
  },
  {
    key: "commission",
    label: "Commission",
    scope: "app",
    bench: "solana-trading-platform-wars",
    panel: "revenue_1d",
    fmt: fmtUSD0,
    tip: "What the app itself collected on its latest closed UTC day, every chain summed (DeFiLlama dailyRevenue). The app's own cut, not the total fees paid on the trade.",
    higherBetter: true,
  },
  {
    key: "takeRate",
    label: "Take Rate",
    scope: "app",
    bench: "solana-trading-platform-wars",
    panel: "take_1d",
    fmt: fmtPct,
    tip: "The app's commission as a percentage of the volume it routed on the same day. Lower is cheaper for the trader; it is the app's cut, not the all-in cost of a swap.",
    higherBetter: false,
  },
  {
    key: "rating",
    label: "App Rating",
    scope: "app",
    bench: "app-store-ratings",
    fmt: fmtRating,
    tip: "Apple App Store all-time average rating. Axiom, Trojan, Photon and Maestro have no iOS app, so they show no figure.",
    higherBetter: true,
  },
];

/** The columns this deployment can actually fill. */
export const TRADING_APP_COLUMNS: readonly TradingAppColumn[] =
  ALL_TRADING_APP_COLUMNS.filter((c) => !isDevOnlyBench(c.bench));

export type TradingAppRow = {
  slug: string;
  name: string;
  values: Record<TradingAppColKey, number | null>;
  /** 1-based rank per column among platforms with a value; null when absent. */
  ranks: Record<TradingAppColKey, { rank: number; of: number } | null>;
  /** The bench's own per-platform formula for each column (spec
   *  provider.formula): says which chains and which dataset the figure
   *  covers. FOMO's volume is Solana-only while GMGN's is cross-chain;
   *  the column tip alone would misstate that. */
  formulas: Record<TradingAppColKey, string | null>;
};

export type TradingAppMatrix = {
  rows: TradingAppRow[];
  /** Best value per column across the cohort (max, or min where less is better). */
  bests: Partial<Record<TradingAppColKey, number | null>>;
  /** Resolved ranking direction per column: the panel's own flag for a
   *  panel-backed column, so no surface can rank against its spec. */
  dirs: Partial<Record<TradingAppColKey, boolean>>;
  updatedAt: string | null;
};

function indexBySlug(results: ProviderResult[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results ?? []) out[r.slug] = r.ms.p50;
  return out;
}

function formulaBySlug(results: ProviderResult[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of results ?? []) if (r.formula) out[r.slug] = r.formula;
  return out;
}

/** Every platform's figures for the columns this deployment serves, with
 *  per-column ranks. Volume is not here: it lives in bench 267 (DeFiLlama,
 *  cross-chain), so one app has one volume figure per page. */
export async function loadTradingAppMatrix(): Promise<TradingAppMatrix> {
  const benches = await Promise.all(TRADING_APP_COLUMNS.map((c) => getBenchmark(c.bench)));
  // A column either reads its bench's headline value per provider, or a named
  // metric panel of it: bench 201's commission and take rate are panels
  // alongside its volume headline.
  const idx = TRADING_APP_COLUMNS.map((c, i) => {
    if (!c.panel) return [c.key, indexBySlug(benches[i]?.results)] as const;
    const panel = benches[i]?.metricPanels?.find((p) => p.id === c.panel);
    return [c.key, { ...(panel?.values ?? {}) } as Record<string, number>] as const;
  });
  // A panel-backed column takes its direction from the panel, so the bench page
  // and this table can never rank the same numbers opposite ways. The literal in
  // the column is only the fallback for a panel that is not published.
  const dirOf = new Map<TradingAppColKey, boolean>(
    TRADING_APP_COLUMNS.map((c, i) => {
      if (!c.panel) return [c.key, c.higherBetter];
      const panel = benches[i]?.metricPanels?.find((p) => p.id === c.panel);
      return [c.key, panel ? panel.higherIsBetter : c.higherBetter];
    }),
  );
  const higherBetterOf = (c: TradingAppColumn) => dirOf.get(c.key) ?? c.higherBetter;
  const fidx = TRADING_APP_COLUMNS.map((c, i) => [c.key, formulaBySlug(benches[i]?.results)] as const);
  const rows: TradingAppRow[] = TRADING_APP_PLATFORMS.map((p) => {
    const values = {} as Record<TradingAppColKey, number | null>;
    for (const [key, map] of idx) values[key] = map[p.slug] ?? null;
    const formulas = {} as Record<TradingAppColKey, string | null>;
    for (const [key, map] of fidx) formulas[key] = map[p.slug] ?? null;
    return { slug: p.slug, name: p.name, values, ranks: {} as TradingAppRow["ranks"], formulas };
  });
  for (const col of TRADING_APP_COLUMNS) {
    const higherBetter = higherBetterOf(col);
    const ranked = rows
      .filter((r) => r.values[col.key] !== null)
      .sort((a, b) =>
        higherBetter
          ? (b.values[col.key] as number) - (a.values[col.key] as number)
          : (a.values[col.key] as number) - (b.values[col.key] as number),
      );
    rows.forEach((r) => {
      const i = ranked.findIndex((x) => x.slug === r.slug);
      r.ranks[col.key] = i >= 0 ? { rank: i + 1, of: ranked.length } : null;
    });
  }
  // A row with nothing in it is a hole, not a measurement: Maestro and
  // BasedBot only ever had Dune figures, so on a deployment without those
  // benches they leave the table rather than filling it with dashes.
  const filled = rows.filter((r) => TRADING_APP_COLUMNS.some((c) => r.values[c.key] !== null));
  rows.length = 0;
  rows.push(...filled);
  // Sort by the first served column anything has a value for, so the order does
  // not depend on a bench that may be gated.
  const sortCol =
    TRADING_APP_COLUMNS.find(
      (c) => higherBetterOf(c) && rows.some((r) => r.values[c.key] !== null),
    ) ?? TRADING_APP_COLUMNS[0];
  if (sortCol) {
    rows.sort((a, b) => (b.values[sortCol.key] ?? -1) - (a.values[sortCol.key] ?? -1));
  }
  const dirs: TradingAppMatrix["dirs"] = {};
  for (const col of TRADING_APP_COLUMNS) dirs[col.key] = higherBetterOf(col);
  const bests: TradingAppMatrix["bests"] = {};
  for (const col of TRADING_APP_COLUMNS) {
    const vals = rows.map((r) => r.values[col.key]).filter((v): v is number => v !== null);
    bests[col.key] = vals.length
      ? (higherBetterOf(col) ? Math.max(...vals) : Math.min(...vals))
      : null;
  }
  const updatedAt = benches.reduce<string | null>((acc, b) => {
    const t = b?.lastRunAt ?? null;
    if (!t) return acc;
    return !acc || new Date(t) > new Date(acc) ? t : acc;
  }, null);
  return { rows, bests, dirs, updatedAt };
}

export function fmtUSD(v: number | null): string {
  if (v === null) return "—";
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(0)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

export function fmtCount(v: number | null): string {
  if (v === null) return "—";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return v.toFixed(0);
}

export function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return `${v.toFixed(2)}%`;
}

export function fmtRating(v: number | null): string {
  if (v === null) return "—";
  return `${v.toFixed(1)} / 5`;
}

export function fmtUSD0(v: number | null): string {
  if (v === null) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}
