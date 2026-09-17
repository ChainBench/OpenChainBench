import { getBenchmark } from "@/data/benchmarks";
import type { ProviderResult } from "@/types/benchmark";

/**
 * Trading-app cohort shared by the /trading-apps hub and the "Trading
 * app" view on /products/<slug>: the platforms, the six KPI columns and
 * the bench each column reads, plus one loader that returns every
 * platform's row with its rank per column so both surfaces show the
 * same numbers.
 *
 * Volume source: Dune community datasets (dataset_*_daily). Each
 * platform is a separate dataset with cross-chain breakdown. pump.fun =
 * pumpapp Solana + relay swaps. Terminal (slug: padre) = pump.fun's own
 * trading app (formerly Padre, acq. Apr 2025). BasedBot is a multi-chain
 * bot (Robinhood node, BNB, Base, Solana, ETH, HyperEVM).
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
  | "volume"
  | "traders"
  | "tradeSize"
  | "wallets"
  | "feeRate"
  | "rating";

export const TRADING_APP_COLUMNS: readonly {
  key: TradingAppColKey;
  label: string;
  bench: string;
  fmt: (v: number | null) => string;
  tip: string;
  higherBetter: boolean;
}[] = [
  {
    key: "volume",
    label: "24h Volume",
    bench: "solana-trading-platform-wars",
    fmt: fmtUSD,
    tip: "Cross-chain 24h volume from Dune community datasets. Includes Solana + BNB + Base + Robinhood node + HyperEVM + Monad etc. pump.fun = pumpapp frontend only (not all bonding-curve). Terminal = pump.fun's own trading app (formerly Padre, acq. Apr 2025).",
    higherBetter: true,
  },
  {
    key: "traders",
    label: "Swap Tx",
    bench: "solana-unique-traders",
    fmt: fmtCount,
    tip: "Unique swap transactions in 24h via Dune. pump.fun uses dex_solana.trades (all swaps incl. 0-fee). Terminals use fee-wallet detection (fee-generating swaps only). Methods differ.",
    higherBetter: true,
  },
  {
    key: "tradeSize",
    label: "Avg Trade",
    bench: "solana-avg-trade-size",
    fmt: fmtUSD,
    tip: "24h volume ÷ trade count via Mobula. Includes bots and MEV — platforms with heavy bot sniping (notably pump.fun) show lower averages than human-only baselines.",
    higherBetter: true,
  },
  {
    key: "wallets",
    label: "Active Wallets",
    bench: "trading-platform-wallets",
    fmt: fmtCount,
    tip: "Unique wallets that traded through the platform in the last complete day (Dune community datasets). Cross-chain for GMGN/Axiom/BasedBot/Terminal. Better signal of real user base than raw tx count.",
    higherBetter: true,
  },
  {
    key: "feeRate",
    label: "Fee Rate",
    bench: "memecoin-platforms",
    fmt: fmtPct,
    tip: "Observed take rate: fee revenue ÷ fee-paying volume (Dune tx join). Comparable across platforms. FOMO uses DeFiLlama (includes off-chain relay fees). pump.fun cut trading fees to 0% in Aug 2026.",
    higherBetter: false,
  },
  {
    key: "rating",
    label: "App Rating",
    bench: "app-store-ratings",
    fmt: fmtRating,
    tip: "Apple App Store all-time average rating. Axiom, Trojan, Photon and Maestro have no iOS app — they show —.",
    higherBetter: true,
  },
];

export type TradingAppRow = {
  slug: string;
  name: string;
  values: Record<TradingAppColKey, number | null>;
  /** 1-based rank per column among platforms with a value; null when absent. */
  ranks: Record<TradingAppColKey, { rank: number; of: number } | null>;
};

export type TradingAppMatrix = {
  rows: TradingAppRow[];
  /** Best value per column across the cohort (max, or min for fee rate). */
  bests: Partial<Record<TradingAppColKey, number | null>>;
  updatedAt: string | null;
};

function indexBySlug(results: ProviderResult[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results ?? []) out[r.slug] = r.ms.p50;
  return out;
}

/** Every platform's six figures with per-column ranks, sorted by 24h volume. */
export async function loadTradingAppMatrix(): Promise<TradingAppMatrix> {
  const benches = await Promise.all(TRADING_APP_COLUMNS.map((c) => getBenchmark(c.bench)));
  const idx = TRADING_APP_COLUMNS.map((c, i) => [c.key, indexBySlug(benches[i]?.results)] as const);
  const rows: TradingAppRow[] = TRADING_APP_PLATFORMS.map((p) => {
    const values = {} as Record<TradingAppColKey, number | null>;
    for (const [key, map] of idx) values[key] = map[p.slug] ?? null;
    return { slug: p.slug, name: p.name, values, ranks: {} as TradingAppRow["ranks"] };
  });
  for (const col of TRADING_APP_COLUMNS) {
    const ranked = rows
      .filter((r) => r.values[col.key] !== null)
      .sort((a, b) =>
        col.higherBetter
          ? (b.values[col.key] as number) - (a.values[col.key] as number)
          : (a.values[col.key] as number) - (b.values[col.key] as number),
      );
    rows.forEach((r) => {
      const i = ranked.findIndex((x) => x.slug === r.slug);
      r.ranks[col.key] = i >= 0 ? { rank: i + 1, of: ranked.length } : null;
    });
  }
  rows.sort((a, b) => (b.values.volume ?? -1) - (a.values.volume ?? -1));
  const bests: TradingAppMatrix["bests"] = {};
  for (const col of TRADING_APP_COLUMNS) {
    const vals = rows.map((r) => r.values[col.key]).filter((v): v is number => v !== null);
    bests[col.key] = vals.length ? (col.higherBetter ? Math.max(...vals) : Math.min(...vals)) : null;
  }
  const updatedAt = benches.reduce<string | null>((acc, b) => {
    const t = b?.lastRunAt ?? null;
    if (!t) return acc;
    return !acc || new Date(t) > new Date(acc) ? t : acc;
  }, null);
  return { rows, bests, updatedAt };
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
