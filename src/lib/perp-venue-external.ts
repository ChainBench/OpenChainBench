/**
 * External per-venue stats fetchers for /perp/[slug] pages.
 * Each venue has its own API surface; this module dispatches to the
 * right source and returns a normalized shape the page can render.
 *
 * Caching: fetch() calls carry next.revalidate=300 so the CDN edge
 * caches for 5 min. The outer unstable_cache memoizes the whole result
 * across concurrent SSR renders within the same edge invocation.
 */

import { unstable_cache } from "next/cache";

export type DailyBar = { date: string; valueUsd: number };

export type PerpVenueExternalStats = {
  totalVolumeUsd?: number;
  totalTradeCount?: number;
  totalFeesUsd?: number;
  /** 25–30 daily bars for the volume bar chart. */
  dailyVolumeChart?: DailyBar[];
  dailyFeesChart?: DailyBar[];
  vaultTvlUsd?: number;
  stakingAprPct?: number;
  collateralBreakdown?: { symbol: string; tvlUsd: number; aprPct: number }[];
  /** Venue-specific extra KPI cards not covered by the main strip. */
  extraKpis?: { label: string; value: string }[];
};

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

async function jf<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(7000),
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

async function jfPost<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(7000),
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

function fmtUsdShort(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtCount(v: number): string {
  if (!Number.isFinite(v)) return "0";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Gains.trade — backend-global.gains.trade
// ---------------------------------------------------------------------------

type GainsStatsRow = {
  date: string;
  leveraged_volume: string;
  vault_tvl: string;
  lp_apr: string;
  trades_count: string;
  daily_users: string;
};

type GainsAprResp = {
  sssApr?: string;
  collateralRewards?: {
    symbol: string;
    vaultTvl: string;
    vaultApr: string;
  }[];
};

async function fetchGainsStats(): Promise<PerpVenueExternalStats> {
  const [arbStats, baseStats, aprRes] = await Promise.all([
    jf<GainsStatsRow[]>(
      "https://backend-global.gains.trade/api/stats?chainId=42161",
    ),
    jf<GainsStatsRow[]>(
      "https://backend-global.gains.trade/api/stats?chainId=8453",
    ),
    jf<GainsAprResp>(
      "https://backend-global.gains.trade/api/apr?chainId=42161",
    ),
  ]);

  const stats = Array.isArray(arbStats) ? arbStats : [];
  if (stats.length === 0) return {};

  const last = stats[stats.length - 1];

  // all-time = cumulative value in last row
  const totalVolumeUsd = parseFloat(last.leveraged_volume) || undefined;
  const totalTradeCount = parseInt(last.trades_count) || undefined;
  const vaultTvlUsd = parseFloat(last.vault_tvl) || undefined;
  const stakingAprPct = last.lp_apr
    ? parseFloat(last.lp_apr) * 100
    : undefined;

  // daily volume bars = delta between consecutive cumulative rows
  const dailyVolumeChart: DailyBar[] = [];
  for (let i = 1; i < stats.length; i++) {
    const prevRow = stats[i - 1];
    const curRow = stats[i];
    if (!prevRow?.leveraged_volume || !curRow?.leveraged_volume) continue;
    const prev = parseFloat(prevRow.leveraged_volume);
    const cur = parseFloat(curRow.leveraged_volume);
    const vol = cur - prev;
    if (vol >= 0) {
      dailyVolumeChart.push({
        date: stats[i].date.split("T")[0],
        valueUsd: vol,
      });
    }
  }

  // Add Base chain volume on top of Arb daily bars if same date range
  let combinedTotal = totalVolumeUsd ?? 0;
  if (Array.isArray(baseStats) && baseStats.length > 0) {
    const baseByDate = new Map<string, number>();
    for (let i = 1; i < baseStats.length; i++) {
      const prevRow = baseStats[i - 1];
      const curRow = baseStats[i];
      if (!prevRow?.leveraged_volume || !curRow?.leveraged_volume) continue;
      const prev = parseFloat(prevRow.leveraged_volume);
      const cur = parseFloat(curRow.leveraged_volume);
      const vol = cur - prev;
      if (vol >= 0) baseByDate.set(baseStats[i].date.split("T")[0], vol);
    }
    for (const bar of dailyVolumeChart) {
      bar.valueUsd += baseByDate.get(bar.date) ?? 0;
    }
    const baseLast = baseStats[baseStats.length - 1];
    combinedTotal += parseFloat(baseLast.leveraged_volume) || 0;
  }

  return buildGainsResult(
    combinedTotal > 0 ? combinedTotal : totalVolumeUsd,
    totalTradeCount,
    vaultTvlUsd,
    stakingAprPct,
    dailyVolumeChart,
    aprRes,
  );
}

function buildGainsResult(
  totalVolumeUsd: number | undefined,
  totalTradeCount: number | undefined,
  vaultTvlUsd: number | undefined,
  stakingAprPct: number | undefined,
  dailyVolumeChart: DailyBar[],
  aprRes: GainsAprResp | null,
): PerpVenueExternalStats {
  const collateralBreakdown =
    aprRes?.collateralRewards
      ?.filter((cr) => parseFloat(cr.vaultTvl) > 0)
      .map((cr) => ({
        symbol: cr.symbol,
        tvlUsd: parseFloat(cr.vaultTvl) || 0,
        aprPct: parseFloat(cr.vaultApr) * 100 || 0,
      })) ?? [];

  const stakingAprDisplay =
    aprRes?.sssApr
      ? parseFloat(aprRes.sssApr) * 100
      : stakingAprPct;

  const extraKpis: { label: string; value: string }[] = [];
  if (totalTradeCount) {
    extraKpis.push({ label: "Total trades", value: fmtCount(totalTradeCount) });
  }

  return {
    totalVolumeUsd,
    totalTradeCount,
    vaultTvlUsd,
    stakingAprPct: stakingAprDisplay,
    dailyVolumeChart,
    collateralBreakdown,
    extraKpis,
  };
}

// ---------------------------------------------------------------------------
// Lighter — mainnet.zklighter.elliot.ai
// ---------------------------------------------------------------------------

type LighterMetrics = { code: string; metrics: { timestamp: number; data: string }[] };
type LighterStats = { daily_usd_volume: string; daily_trades_count: string; total: number };

async function fetchLighterStats(): Promise<PerpVenueExternalStats> {
  const BASE = "https://mainnet.zklighter.elliot.ai/api/v1";
  const [monthVol, allVol, allTrades, allFees, stats] = await Promise.all([
    jf<LighterMetrics>(`${BASE}/exchangeMetrics?period=m&kind=volume`),
    jf<LighterMetrics>(`${BASE}/exchangeMetrics?period=all&kind=volume`),
    jf<LighterMetrics>(`${BASE}/exchangeMetrics?period=all&kind=trade_count`),
    jf<LighterMetrics>(`${BASE}/exchangeMetrics?period=all&kind=taker_fee`),
    jf<LighterStats>(`${BASE}/exchangeStats`),
  ]);

  const dailyVolumeChart: DailyBar[] =
    monthVol?.metrics?.map((m) => ({
      date: new Date(m.timestamp * 1000).toISOString().split("T")[0],
      valueUsd: parseFloat(m.data) || 0,
    })) ?? [];

  const totalVolumeUsd =
    allVol?.metrics?.reduce((s, m) => s + (parseFloat(m.data) || 0), 0) ||
    undefined;

  const totalTradeCount =
    allTrades?.metrics?.reduce((s, m) => s + (parseFloat(m.data) || 0), 0) ||
    undefined;

  const totalFeesUsd =
    allFees?.metrics?.reduce((s, m) => s + (parseFloat(m.data) || 0), 0) ||
    undefined;

  const extraKpis: { label: string; value: string }[] = [];
  if (stats?.daily_usd_volume) {
    extraKpis.push({
      label: "Volume 24h",
      value: fmtUsdShort(parseFloat(stats.daily_usd_volume)),
    });
  }
  if (stats?.daily_trades_count) {
    extraKpis.push({
      label: "Trades 24h",
      value: fmtCount(parseFloat(stats.daily_trades_count)),
    });
  }

  return { totalVolumeUsd, totalTradeCount, totalFeesUsd, dailyVolumeChart, extraKpis };
}

// ---------------------------------------------------------------------------
// GMX v2 — DeFiLlama
// ---------------------------------------------------------------------------

type LlamaChartResp = {
  totalAllTime?: number;
  total30d?: number;
  totalDataChart?: [number, number][];
};

async function fetchGmxStats(): Promise<PerpVenueExternalStats> {
  const [fees, vol] = await Promise.all([
    jf<LlamaChartResp>("https://api.llama.fi/summary/fees/gmx"),
    jf<LlamaChartResp>("https://api.llama.fi/summary/dexs/gmx"),
  ]);

  const totalFeesUsd = fees?.totalAllTime;
  const totalVolumeUsd = vol?.totalAllTime;

  const dailyVolumeChart: DailyBar[] = (vol?.totalDataChart ?? [])
    .slice(-30)
    .map(([ts, v]) => ({
      date: new Date(ts * 1000).toISOString().split("T")[0],
      valueUsd: v,
    }));

  const dailyFeesChart: DailyBar[] = (fees?.totalDataChart ?? [])
    .slice(-30)
    .map(([ts, v]) => ({
      date: new Date(ts * 1000).toISOString().split("T")[0],
      valueUsd: v,
    }));

  return { totalVolumeUsd, totalFeesUsd, dailyVolumeChart, dailyFeesChart };
}

// ---------------------------------------------------------------------------
// Hyperliquid — api.hyperliquid.xyz/info
// ---------------------------------------------------------------------------

type HlAssetCtx = {
  dayNtlVlm?: string;
  openInterest?: string;
  funding?: string;
};

async function fetchHyperliquidStats(): Promise<PerpVenueExternalStats> {
  const data = await jfPost<[{ universe: { name: string }[] }, HlAssetCtx[]]>(
    "https://api.hyperliquid.xyz/info",
    { type: "metaAndAssetCtxs" },
  );
  if (!data) return {};

  const [meta, ctxs] = data;
  const vol24h = ctxs.reduce(
    (s, c) => s + (parseFloat(c.dayNtlVlm ?? "0") || 0),
    0,
  );
  const totalOI = ctxs.reduce(
    (s, c) => s + (parseFloat(c.openInterest ?? "0") || 0),
    0,
  );

  const extraKpis: { label: string; value: string }[] = [
    { label: "Volume 24h", value: fmtUsdShort(vol24h) },
    { label: "Open Interest", value: fmtUsdShort(totalOI) },
    {
      label: "Listed assets",
      value: String(meta.universe?.length ?? ctxs.length),
    },
  ];

  return { extraKpis };
}

// ---------------------------------------------------------------------------
// dYdX — indexer + DeFiLlama fees
// ---------------------------------------------------------------------------

type DydxMarketResp = {
  markets: Record<
    string,
    { volume24H?: string; openInterest?: string; trades24H?: string }
  >;
};

async function fetchDydxStats(): Promise<PerpVenueExternalStats> {
  const [markets, fees] = await Promise.all([
    jf<DydxMarketResp>("https://indexer.dydx.trade/v4/perpetualMarkets"),
    jf<LlamaChartResp>("https://api.llama.fi/summary/fees/dydx"),
  ]);

  const vals = markets ? Object.values(markets.markets) : [];
  const vol24h = vals.reduce(
    (s, m) => s + (parseFloat(m.volume24H ?? "0") || 0),
    0,
  );
  const oi = vals.reduce(
    (s, m) => s + (parseFloat(m.openInterest ?? "0") || 0),
    0,
  );
  const trades24h = vals.reduce(
    (s, m) => s + (parseFloat(m.trades24H ?? "0") || 0),
    0,
  );

  const totalFeesUsd = fees?.totalAllTime;
  const dailyFeesChart: DailyBar[] = (fees?.totalDataChart ?? [])
    .slice(-30)
    .map(([ts, v]) => ({
      date: new Date(ts * 1000).toISOString().split("T")[0],
      valueUsd: v,
    }));

  const extraKpis: { label: string; value: string }[] = [];
  if (vol24h > 0) extraKpis.push({ label: "Volume 24h", value: fmtUsdShort(vol24h) });
  if (oi > 0) extraKpis.push({ label: "Open Interest", value: fmtUsdShort(oi) });
  if (trades24h > 0)
    extraKpis.push({ label: "Trades 24h", value: fmtCount(trades24h) });
  if (markets)
    extraKpis.push({
      label: "Listed markets",
      value: String(Object.keys(markets.markets).length),
    });

  return { totalFeesUsd, dailyFeesChart, extraKpis };
}

// ---------------------------------------------------------------------------
// Vertex — DeFiLlama
// ---------------------------------------------------------------------------

async function fetchVertexStats(): Promise<PerpVenueExternalStats> {
  const fees = await jf<LlamaChartResp>(
    "https://api.llama.fi/summary/fees/vertex-perps",
  );
  if (!fees) return {};

  const totalFeesUsd = fees.totalAllTime;
  const dailyFeesChart: DailyBar[] = (fees.totalDataChart ?? [])
    .slice(-30)
    .map(([ts, v]) => ({
      date: new Date(ts * 1000).toISOString().split("T")[0],
      valueUsd: v,
    }));

  return { totalFeesUsd, dailyFeesChart };
}

// ---------------------------------------------------------------------------
// Aevo — api.aevo.xyz
// ---------------------------------------------------------------------------

type AevoStats = { total_volume?: string; daily_volume?: string };
type AevoInstrument = { total_volume?: string; total_contracts?: string };

async function fetchAevoStats(): Promise<PerpVenueExternalStats> {
  const [stats, ethPerp] = await Promise.all([
    jf<AevoStats>("https://api.aevo.xyz/statistics"),
    jf<AevoInstrument>("https://api.aevo.xyz/instrument/ETH-PERP"),
  ]);

  const totalVolumeUsd = stats?.total_volume
    ? parseFloat(stats.total_volume)
    : undefined;
  const totalTradeCount = ethPerp?.total_contracts
    ? parseFloat(ethPerp.total_contracts)
    : undefined;

  const extraKpis: { label: string; value: string }[] = [];
  if (stats?.daily_volume) {
    const dv = parseFloat(stats.daily_volume);
    if (dv > 0) extraKpis.push({ label: "Volume 24h", value: fmtUsdShort(dv) });
  }

  return { totalVolumeUsd, totalTradeCount, extraKpis };
}

// ---------------------------------------------------------------------------
// Aster — DeFiLlama fees
// ---------------------------------------------------------------------------

async function fetchAsterStats(): Promise<PerpVenueExternalStats> {
  const fees = await jf<LlamaChartResp>(
    "https://api.llama.fi/summary/fees/aster-perps",
  );
  if (!fees) return {};
  const totalFeesUsd = fees.totalAllTime;
  const dailyFeesChart: DailyBar[] = (fees.totalDataChart ?? [])
    .slice(-30)
    .map(([ts, v]) => ({
      date: new Date(ts * 1000).toISOString().split("T")[0],
      valueUsd: v,
    }));
  return { totalFeesUsd, dailyFeesChart };
}

// ---------------------------------------------------------------------------
// Ostium — DeFiLlama fees
// ---------------------------------------------------------------------------

async function fetchOstiumStats(): Promise<PerpVenueExternalStats> {
  const fees = await jf<LlamaChartResp>(
    "https://api.llama.fi/summary/fees/ostium",
  );
  if (!fees) return {};
  const totalFeesUsd = fees.totalAllTime;
  const dailyFeesChart: DailyBar[] = (fees.totalDataChart ?? [])
    .slice(-30)
    .map(([ts, v]) => ({
      date: new Date(ts * 1000).toISOString().split("T")[0],
      valueUsd: v,
    }));
  return { totalFeesUsd, dailyFeesChart };
}

// ---------------------------------------------------------------------------
// Extended — api.starknet.extended.exchange
// ---------------------------------------------------------------------------

type ExtendedMarket = {
  name: string;
  marketStats?: { dailyVolume?: string; openInterest?: string };
};

async function fetchExtendedStats(): Promise<PerpVenueExternalStats> {
  const markets = await jf<ExtendedMarket[]>(
    "https://api.starknet.extended.exchange/api/v1/info/markets",
  );
  if (!markets) return {};

  const vol24h = markets.reduce(
    (s, m) => s + (parseFloat(m.marketStats?.dailyVolume ?? "0") || 0),
    0,
  );
  const oi = markets.reduce(
    (s, m) => s + (parseFloat(m.marketStats?.openInterest ?? "0") || 0),
    0,
  );
  const perp = markets.filter((m) => m.name.includes("-USD"));

  const extraKpis: { label: string; value: string }[] = [];
  if (vol24h > 0) extraKpis.push({ label: "Volume 24h", value: fmtUsdShort(vol24h) });
  if (oi > 0) extraKpis.push({ label: "Open Interest", value: fmtUsdShort(oi) });
  if (perp.length > 0)
    extraKpis.push({ label: "Perp markets", value: String(perp.length) });

  return { extraKpis };
}

// ---------------------------------------------------------------------------
// Paradex — api.prod.paradex.trade
// ---------------------------------------------------------------------------

type ParadexMarketSummary = {
  symbol?: string;
  "24h_volume"?: string;
  total_volume?: string;
  open_interest?: string;
};

async function fetchParadexStats(): Promise<PerpVenueExternalStats> {
  // Fetch top markets individually
  const TOP_MARKETS = ["BTC-USD-PERP", "ETH-USD-PERP", "SOL-USD-PERP"];
  const results = await Promise.all(
    TOP_MARKETS.map((m) =>
      jf<ParadexMarketSummary>(
        `https://api.prod.paradex.trade/v1/markets/summary?market=${m}`,
      ),
    ),
  );

  const vol24h = results.reduce(
    (s, r) => s + (parseFloat(r?.["24h_volume"] ?? "0") || 0),
    0,
  );
  const totalVolumeUsd = results.reduce(
    (s, r) => s + (parseFloat(r?.total_volume ?? "0") || 0),
    0,
  );
  const oi = results.reduce(
    (s, r) => s + (parseFloat(r?.open_interest ?? "0") || 0),
    0,
  );

  const extraKpis: { label: string; value: string }[] = [];
  if (vol24h > 0) extraKpis.push({ label: "Volume 24h (top 3)", value: fmtUsdShort(vol24h) });
  if (oi > 0) extraKpis.push({ label: "Open Interest (top 3)", value: fmtUsdShort(oi) });

  return {
    totalVolumeUsd: totalVolumeUsd > 0 ? totalVolumeUsd : undefined,
    extraKpis,
  };
}

// ---------------------------------------------------------------------------
// Polymarket — gamma-api
// ---------------------------------------------------------------------------

type GammaEvent = { volume?: string; openInterest?: string; volume24hr?: string };

async function fetchPolymarketStats(): Promise<PerpVenueExternalStats> {
  const events = await jf<GammaEvent[]>(
    "https://gamma-api.polymarket.com/events?limit=100&active=true",
  );
  if (!events) return {};

  const vol24h = events.reduce(
    (s, e) => s + (parseFloat(e.volume24hr ?? "0") || 0),
    0,
  );
  const oi = events.reduce(
    (s, e) => s + (parseFloat(e.openInterest ?? "0") || 0),
    0,
  );

  const extraKpis: { label: string; value: string }[] = [];
  if (vol24h > 0) extraKpis.push({ label: "Volume 24h", value: fmtUsdShort(vol24h) });
  if (oi > 0) extraKpis.push({ label: "Open Interest", value: fmtUsdShort(oi) });
  if (events.length > 0)
    extraKpis.push({ label: "Active markets", value: String(events.length) });

  return { extraKpis };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function fetchExternalRaw(
  cohortSlug: string,
): Promise<PerpVenueExternalStats> {
  try {
    switch (cohortSlug) {
      case "gains":
        return await fetchGainsStats();
      case "lighter":
        return await fetchLighterStats();
      case "gmx-v2":
        return await fetchGmxStats();
      case "hyperliquid":
        return await fetchHyperliquidStats();
      case "dydx":
        return await fetchDydxStats();
      case "vertex":
        return await fetchVertexStats();
      case "aevo":
        return await fetchAevoStats();
      case "aster":
        return await fetchAsterStats();
      case "ostium":
        return await fetchOstiumStats();
      case "extended":
        return await fetchExtendedStats();
      case "paradex":
        return await fetchParadexStats();
      case "polymarket":
        return await fetchPolymarketStats();
      default:
        return {};
    }
  } catch {
    return {};
  }
}

export const fetchPerpVenueExternalStats = unstable_cache(
  fetchExternalRaw,
  ["perp-venue-external-v1"],
  { revalidate: 300, tags: ["perp-venue"] },
);
