/**
 * Reader for the trading-app-volume harness output (bench 267): cross-chain
 * daily swap volume per trading app / Telegram bot on closed UTC days, with
 * the per-chain split, from DeFiLlama's dexs adapters.
 *
 * JSON written by the harness to the aggregate dir and served by Caddy at
 * kv.openchainbench.com/aggregate/trading-apps/history.json. The site only
 * reads it; nothing here touches Prometheus.
 */

import { brandColor } from "./brand";
import { lineColor } from "./series-colors";

const DEFAULT_URL = "https://kv.openchainbench.com/aggregate/trading-apps/history.json";

export type TradingAppDay = { day: string; usd: number; chains?: Record<string, number> };

export type TradingAppSeries = {
  slug: string;
  name: string;
  llamaSlug: string;
  kind: "app" | "bot";
  note?: string;
  /** Replaces the chain-split text when DeFiLlama's chain attribution is not where the trades happen. */
  chainLabel?: string;
  chains: string[];
  days: TradingAppDay[];
  fetchedAt: string;
  error?: string;
};

export type TradingAppHistory = {
  generatedAt: string;
  lastClosedDay: string;
  source: string;
  apps: TradingAppSeries[];
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function parse(raw: unknown): TradingAppHistory | null {
  if (!isRecord(raw) || !Array.isArray(raw.apps)) return null;
  const apps: TradingAppSeries[] = [];
  for (const a of raw.apps) {
    if (!isRecord(a) || typeof a.slug !== "string" || typeof a.name !== "string") continue;
    const days: TradingAppDay[] = [];
    if (Array.isArray(a.days)) {
      for (const d of a.days) {
        if (!isRecord(d) || typeof d.day !== "string" || typeof d.usd !== "number") continue;
        const chains: Record<string, number> = {};
        if (isRecord(d.chains)) {
          for (const [c, v] of Object.entries(d.chains)) if (typeof v === "number") chains[c] = v;
        }
        days.push({ day: d.day, usd: d.usd, ...(Object.keys(chains).length ? { chains } : {}) });
      }
    }
    apps.push({
      slug: a.slug,
      name: a.name,
      llamaSlug: typeof a.llama_slug === "string" ? a.llama_slug : "",
      kind: a.kind === "bot" ? "bot" : "app",
      ...(typeof a.note === "string" && a.note ? { note: a.note } : {}),
      ...(typeof a.chain_label === "string" && a.chain_label ? { chainLabel: a.chain_label } : {}),
      chains: Array.isArray(a.chains) ? a.chains.filter((c): c is string => typeof c === "string") : [],
      days,
      fetchedAt: typeof a.fetched_at === "string" ? a.fetched_at : "",
      ...(typeof a.error === "string" && a.error ? { error: a.error } : {}),
    });
  }
  return {
    generatedAt: typeof raw.generated_at === "string" ? raw.generated_at : "",
    lastClosedDay: typeof raw.last_closed_day === "string" ? raw.last_closed_day : "",
    source: typeof raw.source === "string" ? raw.source : "",
    apps,
  };
}

/** Fetches the history JSON (5 min revalidate). Null when unavailable. */
export async function getTradingAppHistory(): Promise<TradingAppHistory | null> {
  const url = process.env.TRADING_APP_HISTORY_URL || DEFAULT_URL;
  try {
    const res = await fetch(url, { next: { revalidate: 300 }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return parse(await res.json());
  } catch {
    return null;
  }
}

export function findTradingApp(h: TradingAppHistory, slug: string): TradingAppSeries | null {
  return h.apps.find((a) => a.slug === slug) ?? null;
}

/** Sum of the last `n` closed days ending on `lastClosedDay`, with how
 *  many of those days had a point. DeFiLlama series have gaps (GMGN has
 *  none for Aug 26-31 2026), so a window is published with its coverage
 *  rather than dropped; callers show "24/30 d" when it is short. */
export function windowSum(
  app: TradingAppSeries,
  lastClosedDay: string,
  n: number,
): { sum: number; days: number } {
  const byDay = new Map(app.days.map((d) => [d.day, d.usd]));
  let sum = 0;
  let days = 0;
  const end = new Date(lastClosedDay + "T00:00:00Z");
  for (let i = 0; i < n; i++) {
    const d = new Date(end.getTime() - i * 86400_000).toISOString().slice(0, 10);
    const v = byDay.get(d);
    if (v == null) continue;
    sum += v;
    days++;
  }
  return { sum, days };
}

export type TradingAppStats = {
  app: TradingAppSeries;
  d1: number | null;
  d7: number | null;
  d30: number | null;
  /** Days with a point inside the 7d / 30d windows (7 and 30 when complete). */
  d7days: number;
  d30days: number;
  /** Previous 7 closed days, for the trend. */
  d7prev: number | null;
  /** 7d over previous 7d, in percent; null when either is missing or zero. */
  trend7dPct: number | null;
  share30d: number | null;
  /** Chain split of the last closed day, largest first. */
  chainSplit: { chain: string; usd: number; pct: number }[];
  /** Last 30 closed days, oldest first, for sparklines. */
  last30: (number | null)[];
};

/** Per-app windows, trend, share and chain split, sorted by last-day volume. */
export function computeTradingAppStats(h: TradingAppHistory): TradingAppStats[] {
  const stats = h.apps.map((app) => {
    const w1 = windowSum(app, h.lastClosedDay, 1);
    const w7 = windowSum(app, h.lastClosedDay, 7);
    const w30 = windowSum(app, h.lastClosedDay, 30);
    const d1 = w1.days === 1 ? w1.sum : null;
    const d7 = w7.days > 0 ? w7.sum : null;
    const d30 = w30.days > 0 ? w30.sum : null;
    const prevEnd = new Date(new Date(h.lastClosedDay + "T00:00:00Z").getTime() - 7 * 86400_000)
      .toISOString()
      .slice(0, 10);
    const wPrev = windowSum(app, prevEnd, 7);
    // Trend only when both weeks are complete: a week with a gap would
    // read as a drop.
    const d7prev = wPrev.days === 7 ? wPrev.sum : null;
    const trend7dPct = w7.days === 7 && d7prev != null && d7prev > 0 ? ((w7.sum - d7prev) / d7prev) * 100 : null;
    const last = app.days.find((d) => d.day === h.lastClosedDay);
    const total = last?.usd ?? 0;
    const chainSplit = Object.entries(last?.chains ?? {})
      .map(([chain, usd]) => ({ chain, usd, pct: total > 0 ? (usd / total) * 100 : 0 }))
      .sort((a, b) => b.usd - a.usd);
    const byDay = new Map(app.days.map((d) => [d.day, d.usd]));
    const end = new Date(h.lastClosedDay + "T00:00:00Z");
    const last30: (number | null)[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(end.getTime() - i * 86400_000).toISOString().slice(0, 10);
      last30.push(byDay.get(d) ?? null);
    }
    return { app, d1, d7, d30, d7days: w7.days, d30days: w30.days, d7prev, trend7dPct, share30d: null as number | null, chainSplit, last30 };
  });
  const total30 = stats.reduce((s, x) => s + (x.d30 ?? 0), 0);
  for (const s of stats) s.share30d = s.d30 != null && total30 > 0 ? (s.d30 / total30) * 100 : null;
  return stats.sort((a, b) => (b.d1 ?? -1) - (a.d1 ?? -1));
}

/** Cohort totals per window; a window counts only apps with a full window. */
export function cohortTotals(stats: TradingAppStats[]): { d1: number; d7: number; d30: number } {
  return {
    d1: stats.reduce((s, x) => s + (x.d1 ?? 0), 0),
    d7: stats.reduce((s, x) => s + (x.d7 ?? 0), 0),
    d30: stats.reduce((s, x) => s + (x.d30 ?? 0), 0),
  };
}

/**
 * Colour for a DeFiLlama chain label, shared by the cohort bar and the
 * per-row chain bars so Solana is the same violet everywhere. Chains with
 * no brand colour fall back to the palette by position.
 */
const CHAIN_BRAND: Record<string, string> = {
  Solana: "solana",
  "Robinhood Chain": "robinhood",
  BSC: "bnb",
  Base: "base",
  Ethereum: "ethereum",
  Arbitrum: "arbitrum",
  "Hyperliquid L1": "hyperliquid",
  Monad: "monad",
  Sonic: "sonic",
  Polygon: "polygon",
  Avalanche: "avalanche",
  Optimism: "optimism",
  Blast: "blast",
  Tron: "tron",
  Sui: "sui",
};
const CHAIN_FIXED: Record<string, string> = {
  "X Layer": "#B0B0B8",
  Abstract: "#3BD08A",
  Berachain: "#B5703A",
  Linea: "#61DFFF",
};
export function chainColor(chain: string, i: number): string {
  const b = CHAIN_BRAND[chain];
  if (b) {
    const c = brandColor(b);
    if (c) return c;
  }
  return CHAIN_FIXED[chain] ?? lineColor(i);
}

/** Chain totals of the cohort on the last closed day, largest first. */
export function cohortChainSplit(h: TradingAppHistory): { chain: string; usd: number; pct: number }[] {
  const acc = new Map<string, number>();
  for (const a of h.apps) {
    const last = a.days.find((d) => d.day === h.lastClosedDay);
    for (const [c, v] of Object.entries(last?.chains ?? {})) acc.set(c, (acc.get(c) ?? 0) + v);
  }
  const total = [...acc.values()].reduce((s, v) => s + v, 0);
  return [...acc.entries()]
    .map(([chain, usd]) => ({ chain, usd, pct: total > 0 ? (usd / total) * 100 : 0 }))
    .sort((a, b) => b.usd - a.usd);
}

/** Aligned daily matrix for the chart: `days` oldest first over the last
 *  `span` closed days, one series per app (null where the day is missing). */
export function alignedSeries(
  h: TradingAppHistory,
  span: number,
  slugs?: string[],
): { days: string[]; series: { slug: string; name: string; values: (number | null)[] }[] } {
  const end = new Date(h.lastClosedDay + "T00:00:00Z");
  const days: string[] = [];
  for (let i = span - 1; i >= 0; i--) {
    days.push(new Date(end.getTime() - i * 86400_000).toISOString().slice(0, 10));
  }
  const apps = slugs ? h.apps.filter((a) => slugs.includes(a.slug)) : h.apps;
  const series = apps.map((a) => {
    const byDay = new Map(a.days.map((d) => [d.day, d.usd]));
    return { slug: a.slug, name: a.name, values: days.map((d) => byDay.get(d) ?? null) };
  });
  return { days, series };
}
