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
  { slug: "pump-fun", name: "pump.fun app" },
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
  /** False for a column with no better end. The take rate is the app's own
   *  margin net of referral paybacks, so neither direction is good news for a
   *  reader: ranking it low-is-best called an app that rebates a third of its fee
   *  "cheaper" when its traders pay the same. Such a column shows its figures and
   *  no rank, no best and no highlight. Defaults to true. */
  rankable?: boolean;
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
    scope: "solana",
    bench: "terminal-swap-transactions",
    fmt: fmtCount,
    tip: "Swap transactions routed on one complete UTC day, on Solana, from the tehcscreener API. Counted directly rather than inferred from who paid a fee, so a terminal that charges nothing is still counted: pump.fun now appears, having been structurally invisible before.",
    higherBetter: true,
  },
  {
    key: "tradeSize",
    label: "Avg Trade",
    scope: "solana",
    bench: "terminal-avg-trade-size",
    fmt: fmtUSD,
    tip: "One complete UTC day's routed Solana volume divided by that day's swap count, from the tehcscreener API. Includes bots and MEV, so a terminal carrying heavy sniping reads lower than a human-only baseline would. Padre, Phantom and Bloom left this column on 2026-10-07: the current source does not cover them, and a row that cannot be measured is removed rather than shown as zero.",
    higherBetter: true,
  },
  {
    key: "wallets",
    label: "Active Wallets",
    scope: "solana",
    bench: "trading-platform-wallets",
    fmt: fmtCount,
    tip: "Distinct wallets that traded through the terminal on one complete UTC day, on Solana, from the tehcscreener API. A better signal of a user base than raw transaction count. Counted directly, so Fomo and pump.fun now carry a figure; BasedBot routes almost nothing on Solana and reads unresponsive.",
    higherBetter: true,
  },
  {
    key: "feeRate",
    label: "Fee Rate",
    scope: "solana",
    bench: "memecoin-platforms",
    fmt: fmtPct,
    tip: "Observed take rate on Solana from the tehcscreener API: one day's fee revenue over that day's routed volume, both from the same row. A lower bound on the published fee, since waivers and rebates reduce what a terminal keeps. A cell is left blank rather than ranked when a terminal charges on one chain and reports exactly nothing on another, since a waived fee and an unmeasured one look identical here.",
    higherBetter: false,
  },
  {
    key: "commission",
    label: "Commission",
    scope: "app",
    bench: "solana-trading-platform-wars",
    panel: "revenue_1d",
    fmt: fmtUSD0,
    tip: "What the app itself collected, every chain summed (DeFiLlama dailyRevenue). The app's own cut, not the total fees paid on the trade. It covers the newest UTC day carrying both a volume and a commission figure, which can trail the volume day by up to 3 days when the fees adapter is behind.",
    higherBetter: true,
  },
  // The "Take rate" column was removed on 2026-10-07. It came from bench 201
  // and Fee Rate comes from bench 203; once both read tehcscreener they became
  // the same number from the same source, and two identical columns side by
  // side read as a mistake rather than as corroboration.
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

/** Where each column's figures come from, for the headings and footnotes that
 *  have to name the source. Keyed by bench so a column set built from
 *  TRADING_APP_COLUMNS can describe itself rather than hardcoding "Dune". */
const SOURCE_BY_BENCH: Record<string, string> = {
  // Every bench on this hub reads tehcscreener as of 2026-10-07, except the
  // App Store ratings, which that source does not carry. One source is a
  // deliberate choice: the hub previously showed a DeFiLlama take rate beside
  // a tehcscreener fee rate, disagreeing by up to a factor of two on the same
  // terminal, which is a contradiction a reader cannot resolve. The cost is
  // that nothing here is cross-checked any more.
  "terminal-swap-transactions": "tehcscreener",
  "terminal-avg-trade-size": "tehcscreener",
  "trading-platform-wallets": "tehcscreener",
  "memecoin-platforms": "tehcscreener",
  "solana-trading-platform-wars": "tehcscreener",
  "app-store-ratings": "the App Store",
};

/** The sources behind a set of columns, in order, without repeats. */
export function columnSources(cols: readonly TradingAppColumn[]): string[] {
  const out: string[] = [];
  for (const c of cols) {
    const s = SOURCE_BY_BENCH[c.bench];
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** "A", "A and B", "A, B and C". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

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
    if (col.rankable === false) {
      rows.forEach((r) => {
        r.ranks[col.key] = null;
      });
      continue;
    }
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
  // A row with nothing in it is a hole, not a measurement. Maestro and BasedBot
  // are the two platforms here with no DeFiLlama adapter and no App Store entry,
  // so on a deployment without the Dune benches they have nothing left to show
  // and leave the table rather than filling it with dashes. Maestro's average
  // trade came from Mobula rather than Dune, but that column goes with the same
  // bench.
  const filled = rows.filter((r) => TRADING_APP_COLUMNS.some((c) => r.values[c.key] !== null));
  rows.length = 0;
  rows.push(...filled);
  // Sort by the first served column anything has a value for, so the order does
  // not depend on a bench that may be gated.
  const sortCol =
    TRADING_APP_COLUMNS.find(
      (c) => c.rankable !== false && higherBetterOf(c) && rows.some((r) => r.values[c.key] !== null),
    ) ?? TRADING_APP_COLUMNS[0];
  if (sortCol) {
    rows.sort((a, b) => (b.values[sortCol.key] ?? -1) - (a.values[sortCol.key] ?? -1));
  }
  const dirs: TradingAppMatrix["dirs"] = {};
  for (const col of TRADING_APP_COLUMNS) dirs[col.key] = higherBetterOf(col);
  const bests: TradingAppMatrix["bests"] = {};
  for (const col of TRADING_APP_COLUMNS) {
    if (col.rankable === false) {
      bests[col.key] = null;
      continue;
    }
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
