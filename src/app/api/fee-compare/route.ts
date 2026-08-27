import { NextResponse } from "next/server";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { keccak256 } from "js-sha3";

export const runtime = "nodejs";
export const maxDuration = 50;
// dYdX indexer geoblocks US IPs — force function to run in EU
export const preferredRegion = ["cdg1", "fra1", "ams1"];

const HL_API = "https://api.hyperliquid.xyz/info";
const GAINS_VARS_URL = "https://backend-arbitrum.gains.trade/trading-variables";
const GAINS_HISTORY_API = "https://backend-global.gains.trade";
const GMX_SUBSQUID = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
const DYDX_INDEXER = "https://indexer.dydx.trade";

const GAINS_FEE_PRECISION = 1e12;
const HL_TAKER_FALLBACK = 0.00035;

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const DYDX_ADDRESS_RE = /^dydx1[a-z0-9]{38}$/;
const MAX_DISPLAY_FILLS = 50;
const RATE_CACHE_TTL_MS = 60 * 60 * 1000;

const VENUE_NAMES: Record<string, string> = {
  hyperliquid: "Hyperliquid",
  gains: "Gains",
  dydx: "dYdX v4",
  "gmx-v2": "GMX v2",
  paradex: "Paradex",
  edgex: "EdgeX",
};

const VALID_SLUGS = new Set(Object.keys(VENUE_NAMES));
const EVM_WALLET_VENUES = new Set(["hyperliquid", "gains", "gmx-v2"]);

// ──────────────────────────────────────────────────────────────────────
// Rate caches
// ──────────────────────────────────────────────────────────────────────

// Gains v6 borrowingRatePerSecondP uses 1e18; lastFundingRatePerSecondP uses 1e21
const GAINS_BORROW_PRECISION = 1e18;
const GAINS_FUNDING_PRECISION = 1e21;
// Fallback when API doesn't expose per-pair data (~0.04%/day expressed per-second)
const GAINS_BORROW_DEFAULT_PER_SEC = 0.0004 / 86400;
// USDC is array[2] in vars.collaterals (0-indexed); its collateralIndex field = 3 (1-indexed).
// The collateralIndex===3 filter in fetchGainsTrades refers to the field value, not the array position.
const GAINS_USDC_COLLATERAL_IDX = 2;

let gainsFeeCache: {
  coinRoundTrip: Record<string, number>;
  perSide: Record<string, number>;
  avgPerSide: number;
  borrowPerSecPerCoin: Record<string, number>;
  avgBorrowPerSec: number;
  fundingPerSecPerCoin: Record<string, number>;
  ts: number;
} | null = null;

type RateCacheEntry = { rate: number; note: string; ts: number };
const rateCache: Partial<Record<string, RateCacheEntry>> = {};

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

type HlFill = {
  coin: string;
  px: string;
  sz: string;
  fee: string;
  time: number;
  dir: string;
  side: string;
  closedPnl: string;
  crossed: boolean;
};

type HlFundingEvent = {
  time: number;
  delta: { usdc: string };
};

type GainsApiTrade = {
  id: number;
  date: string;
  pair: string;
  action: string;
  buy?: boolean;
  price: number;
  size: number;
  leverage: number;
  pnl_net: number;
  collateralIndex: number;
  meta?: {
    tradeFeesData?: { realizedTradingFeesCollateral?: number };
    uiRealizedPnlData?: {
      realizedTradingFeesCollateral?: number;
      realizedFundingFeesCollateral?: number;
      realizedNewBorrowingFeesCollateral?: number;
    };
  };
};

type GainsTradingVars = {
  pairs: Array<{ from: string; feeIndex: string; groupIndex?: string }>;
  fees: Array<{ totalPositionSizeFeeP: string; borrowingFeePerBlockP?: string }>;
  // Legacy top-level structure (v5)
  borrowingFees?: {
    groups?: Array<{ currentPerBlockP?: string; borrowingFeePerBlockP?: string }>;
    pairs?: Array<{ feeIndex?: string; groupIndex?: string }>;
  };
  // Per-collateral structure (v6+): indexed by collateralIndex
  collaterals?: Array<{
    borrowingFees?: {
      v2?: {
        pairParams?: Array<{ borrowingRatePerSecondP?: string }>;
      };
    };
    fundingFees?: {
      pairData?: Array<{ lastFundingRatePerSecondP?: string }>;
    };
  } | null>;
};

type HlWalletData = {
  fills: number;
  notionalUsd: number;
  feesUsd: number;
  fundingUsd: number;
  netCostUsd: number;
  avgFeeRateBps: number;
  topCoins: Array<{ coin: string; fills: number; notional: number; fees: number }>;
  recentFills: Array<{
    time: number;
    coin: string;
    dir: string;
    side: string;
    notional: number;
    hlFee: number;
    equivFee?: number;
    closedPnl: number;
    isTaker: boolean;
  }>;
};

type GainsWalletData = {
  events: number;
  feesUsdc: number;
  fundingFeesUsdc: number;
  fundingEstimated: boolean;
  borrowingFeesUsdc: number;
  netCostUsdc: number;
  positionSizeUsdc: number;
  avgFeeRateBps: number;
  recentTrades: Array<{
    date: string;
    pair: string;
    action: string;
    notional: number;
    tradingFee: number;
    fundingFee: number;
    borrowingFee: number;
    pnl_net: number;
  }>;
};

type GmxWalletData = {
  trades: number;
  feesUsdc: number;
  borrowingFeesUsdc: number;
  fundingFeesUsdc: number;
  netCostUsdc: number;
  notionalUsd: number;
  avgFeeRateBps: number;
  recentTrades: Array<{
    timestamp: number;
    sizeDeltaUsd: number;
    isLong: boolean;
    tradingFee: number;
    borrowingFee: number;
    fundingFee: number;
    pnlUsd: number;
  }>;
};

type DydxWalletData = {
  fills: number;
  feesUsdc: number;
  fundingUsd: number;
  netCostUsdc: number;
  notionalUsd: number;
  avgFeeRateBps: number;
};

type AnyWallet = HlWalletData | GainsWalletData | GmxWalletData | DydxWalletData;

type VenueResult = {
  slug: string;
  name: string;
  ratePerAction: number;
  rateBps: number;
  rateNote: string;
  rateIsLive: boolean;
  wallet: AnyWallet | null;
  effectiveRateBps?: number;
  effectiveRateNote?: string;
};

type PositionSlice = {
  coin: string;
  notionalUsd: number;
  openMs: number;
  closeMs: number;
  isLong: boolean;
};

type SimResult = {
  notionalUsed: number;
  feesActual: number;
  equivFees: number;
  saved: number;
  multiple: number | null;
  fundingUsd?: number;
  projectedCarry?: {
    takerFees: number;
    borrowFees: number;
    fundingFees: number;
    borrowProjected: boolean;
    fundingProjected: boolean;
  };
};

type ComparisonResult = {
  aToBSim: SimResult | null;
  bToASim: SimResult | null;
};

// ──────────────────────────────────────────────────────────────────────
// Fetch helpers
// ──────────────────────────────────────────────────────────────────────

async function fetchGainsFeeRates(): Promise<{
  coinRoundTrip: Record<string, number>;
  perSide: Record<string, number>;
  avgPerSide: number;
  borrowPerSecPerCoin: Record<string, number>;
  avgBorrowPerSec: number;
  fundingPerSecPerCoin: Record<string, number>;
}> {
  const now = Date.now();
  if (gainsFeeCache && now - gainsFeeCache.ts < RATE_CACHE_TTL_MS) {
    return gainsFeeCache;
  }
  const res = await fetch(GAINS_VARS_URL, {
    signal: AbortSignal.timeout(8000),
    next: { revalidate: 3600 },
  });
  const vars = (await res.json()) as GainsTradingVars;
  const coinRoundTrip: Record<string, number> = {};
  const perSide: Record<string, number> = {};
  const borrowPerSecPerCoin: Record<string, number> = {};
  const fundingPerSecPerCoin: Record<string, number> = {};

  // Gains v6: per-collateral carry data indexed by collateralIndex
  // collateralIndex 3 = USDC on Arbitrum (same filter used in fetchGainsTrades)
  const usdcCollateral = vars.collaterals?.[GAINS_USDC_COLLATERAL_IDX];

  // Per-pair borrow rates (v2 system, rates per-second at precision 1e18)
  const v2BorrowParams = usdcCollateral?.borrowingFees?.v2?.pairParams ?? [];
  // Per-pair funding rates (per-second at precision 1e18)
  const fundingPairData = usdcCollateral?.fundingFees?.pairData ?? [];

  for (let i = 0; i < vars.pairs.length; i++) {
    const p = vars.pairs[i];
    if (coinRoundTrip[p.from]) continue;

    const fi = parseInt(p.feeIndex, 10);
    const entry = vars.fees[fi];
    if (!entry) continue;

    // Taker fee rate
    const ps = parseInt(entry.totalPositionSizeFeeP, 10) / GAINS_FEE_PRECISION;
    coinRoundTrip[p.from] = ps * 2;
    perSide[p.from] = ps;

    // Borrow rate per second (v2 takes precedence over legacy)
    const v2Borrow = v2BorrowParams[i]?.borrowingRatePerSecondP;
    if (v2Borrow) {
      borrowPerSecPerCoin[p.from] = parseFloat(v2Borrow) / GAINS_BORROW_PRECISION;
    }

    // Funding rate per second (absolute value — longs and shorts may face same magnitude)
    const fundingRate = fundingPairData[i]?.lastFundingRatePerSecondP;
    if (fundingRate) {
      fundingPerSecPerCoin[p.from] = Math.abs(parseFloat(fundingRate)) / GAINS_FUNDING_PRECISION;
    }
  }

  const sides = Object.values(perSide);
  const avgPerSide = sides.length > 0 ? sides.reduce((a, b) => a + b, 0) / sides.length : 0.0005;

  const borrowRates = Object.values(borrowPerSecPerCoin);
  const avgBorrowPerSec =
    borrowRates.length > 0
      ? borrowRates.reduce((a, b) => a + b, 0) / borrowRates.length
      : GAINS_BORROW_DEFAULT_PER_SEC;

  gainsFeeCache = {
    coinRoundTrip,
    perSide,
    avgPerSide,
    borrowPerSecPerCoin,
    avgBorrowPerSec,
    fundingPerSecPerCoin,
    ts: now,
  };
  return gainsFeeCache;
}

async function fetchHlRate(): Promise<{ rate: number; note: string }> {
  const cached = rateCache["hyperliquid"];
  if (cached && Date.now() - cached.ts < RATE_CACHE_TTL_MS) return cached;
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "userFees", user: "0x0000000000000000000000000000000000000000" }),
    signal: AbortSignal.timeout(8000),
  });
  const data = (await res.json()) as { userCrossRate?: string };
  const rate = parseFloat(data.userCrossRate ?? String(HL_TAKER_FALLBACK));
  const entry = { rate, note: `${(rate * 10000).toFixed(2)} bps taker (live from HL fee schedule)`, ts: Date.now() };
  rateCache["hyperliquid"] = entry;
  return entry;
}

async function fetchParadexRate(): Promise<{ rate: number; note: string }> {
  const cached = rateCache["paradex"];
  if (cached && Date.now() - cached.ts < RATE_CACHE_TTL_MS) return cached;
  const res = await fetch("https://api.prod.paradex.trade/v1/markets?market=BTC-USD-PERP", {
    signal: AbortSignal.timeout(8000),
  });
  const data = (await res.json()) as {
    results?: Array<{ fee_config?: { api_fee?: { taker_fee?: { fee?: string } } } }>;
  };
  const rawRate = data.results?.[0]?.fee_config?.api_fee?.taker_fee?.fee ?? "0.0002";
  const rate = parseFloat(rawRate);
  const entry = { rate, note: `${(rate * 10000).toFixed(2)} bps taker (live from Paradex)`, ts: Date.now() };
  rateCache["paradex"] = entry;
  return entry;
}

async function fetchEdgeXRate(): Promise<{ rate: number; note: string }> {
  const cached = rateCache["edgex"];
  if (cached && Date.now() - cached.ts < RATE_CACHE_TTL_MS) return cached;
  const res = await fetch("https://edgex-prod-v2.edgex.exchange/api/v2/public/meta/getMetaData", {
    signal: AbortSignal.timeout(8000),
  });
  const data = (await res.json()) as {
    data?: { contractList?: Array<{ defaultTakerFeeRate?: string | number }> };
  };
  const contracts = data.data?.contractList ?? [];
  const rates = contracts.map((c) => parseFloat(String(c.defaultTakerFeeRate ?? "0"))).filter((r) => r > 0);
  const rate = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0.00038;
  const entry = { rate, note: `${(rate * 10000).toFixed(2)} bps taker (live from EdgeX)`, ts: Date.now() };
  rateCache["edgex"] = entry;
  return entry;
}

async function fetchGmxLiveRate(): Promise<{ rate: number; note: string }> {
  const cached = rateCache["gmx-v2"];
  if (cached && Date.now() - cached.ts < RATE_CACHE_TTL_MS) return cached;
  // Filter to USDC-collateral only: other tokens have different decimals,
  // making positionFeeAmount/1e6 astronomically wrong.
  const query = `{
    tradeActions(
      where: {
        positionFeeAmount_isNull: false
        sizeDeltaUsd_gt: "0"
        orderType_in: [2, 3, 4]
        initialCollateralTokenAddress_in: [
          "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
          "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8"
        ]
      }
      orderBy: timestamp_DESC
      limit: 50
    ) { sizeDeltaUsd positionFeeAmount }
  }`;
  const res = await fetch(GMX_SUBSQUID, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(10000),
  });
  const body = (await res.json()) as {
    data?: { tradeActions: Array<{ sizeDeltaUsd: string; positionFeeAmount: string }> };
  };
  const trades = body.data?.tradeActions ?? [];
  let totalFees = 0;
  let totalNotional = 0;
  for (const t of trades) {
    const fee = Number(BigInt(t.positionFeeAmount)) / 1e6;
    const notional = Number(BigInt(t.sizeDeltaUsd) / BigInt("1000000000000000000000000")) / 1e6;
    // Skip corrupted subsquid rows (fee > 1% of notional is impossible at GMX)
    if (notional <= 0 || fee / notional > 0.01) continue;
    totalFees += fee;
    totalNotional += notional;
  }
  const rate = totalNotional > 0 ? totalFees / totalNotional : 0.0005;
  const entry = { rate, note: `${(rate * 10000).toFixed(2)} bps (live avg from recent GMX v2 trades)`, ts: Date.now() };
  rateCache["gmx-v2"] = entry;
  return entry;
}

async function resolveRate(slug: string): Promise<{ rate: number; note: string; rateIsLive: boolean }> {
  if (slug === "gains") {
    const d = await fetchGainsFeeRates();
    return { rate: d.avgPerSide, note: "Live per-coin taker rate (avg across pairs)", rateIsLive: true };
  }
  if (slug === "hyperliquid") {
    const r = await fetchHlRate().catch(() => ({ rate: HL_TAKER_FALLBACK, note: "3.50 bps taker (HL base tier)" }));
    return { ...r, rateIsLive: true };
  }
  if (slug === "paradex") {
    const r = await fetchParadexRate().catch(() => ({ rate: 0.0002, note: "2.00 bps taker (Paradex api-tier)" }));
    return { ...r, rateIsLive: true };
  }
  if (slug === "edgex") {
    const r = await fetchEdgeXRate().catch(() => ({ rate: 0.00038, note: "3.80 bps taker (EdgeX)" }));
    return { ...r, rateIsLive: true };
  }
  if (slug === "gmx-v2") {
    const r = await fetchGmxLiveRate().catch(() => ({ rate: 0.0005, note: "5.00 bps taker (GMX v2 fallback)" }));
    return { ...r, rateIsLive: true };
  }
  if (slug === "dydx") return { rate: 0.0005, note: "5.00 bps taker (tier-0, protocol-governed)", rateIsLive: false };
  return { rate: 0.0005, note: "Documented rate", rateIsLive: false };
}

async function fetchHlFills(wallet: string): Promise<HlFill[]> {
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "userFills", user: wallet }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  return Array.isArray(data) ? (data as HlFill[]) : [];
}

async function fetchHlFunding(wallet: string, startMs: number): Promise<HlFundingEvent[]> {
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "userFunding", user: wallet, startTime: startMs }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  return Array.isArray(data) ? (data as HlFundingEvent[]) : [];
}

async function fetchGmxTrades(wallet: string, cutoffMs: number): Promise<GmxWalletData> {
  const fromTimestamp = Math.floor(cutoffMs / 1000);
  const allTrades: Array<{
    timestamp: number; sizeDeltaUsd: string; isLong: boolean;
    positionFeeAmount: string; borrowingFeeAmount: string | null;
    fundingFeeAmount: string | null; pnlUsd: string | null;
  }> = [];
  let cursor: string | null = null;
  let pages = 0;

  const USDC_ADDRS = [
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
  ];

  do {
    const query = `
      query($account: String!, $from: Int!, $after: String) {
        tradeActionsConnection(
          where: {
            account_eq: $account
            timestamp_gte: $from
            eventName_in: ["OrderExecuted"]
            initialCollateralTokenAddress_in: ${JSON.stringify(USDC_ADDRS)}
            sizeDeltaUsd_gt: "0"
          }
          first: 200
          after: $after
          orderBy: timestamp_DESC
        ) {
          edges {
            node {
              timestamp
              sizeDeltaUsd
              isLong
              positionFeeAmount
              borrowingFeeAmount
              fundingFeeAmount
              pnlUsd
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const res = await fetch(GMX_SUBSQUID, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { account: toChecksumAddress(wallet), from: fromTimestamp, after: cursor } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) break;
    const body = (await res.json()) as {
      data?: {
        tradeActionsConnection?: {
          edges: Array<{ node: typeof allTrades[0] }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };
    const conn = body.data?.tradeActionsConnection;
    if (!conn) break;
    allTrades.push(...conn.edges.map((e) => e.node));
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages++;
  } while (cursor && pages < 10);

  let feesUsdc = 0;
  let borrowingFeesUsdc = 0;
  let fundingFeesUsdc = 0;
  let notionalUsd = 0;
  const recentTrades: GmxWalletData["recentTrades"] = [];

  for (const t of allTrades) {
    const tradingFee = Number(BigInt(t.positionFeeAmount ?? "0")) / 1e6;
    const borrowingFee = Number(BigInt(t.borrowingFeeAmount ?? "0")) / 1e6;
    // fundingFeeAmount can be negative (received); keep sign
    const fundingFeeRaw = t.fundingFeeAmount ? BigInt(t.fundingFeeAmount) : BigInt(0);
    const fundingFee = Number(fundingFeeRaw) / 1e6;
    const notional = Number(BigInt(t.sizeDeltaUsd) / BigInt("1000000000000000000000000")) / 1e6;
    const pnlUsd = t.pnlUsd ? Number(BigInt(t.pnlUsd) / BigInt("1000000000000000000000000")) / 1e6 : 0;

    // Skip corrupted subsquid rows (>1% fee rate is impossible at GMX)
    if (notional <= 0 || tradingFee / notional > 0.01) continue;

    feesUsdc += tradingFee;
    borrowingFeesUsdc += borrowingFee;
    fundingFeesUsdc += fundingFee;
    notionalUsd += notional;

    if (recentTrades.length < 50) {
      recentTrades.push({ timestamp: t.timestamp, sizeDeltaUsd: notional, isLong: t.isLong, tradingFee, borrowingFee, fundingFee, pnlUsd });
    }
  }

  const netCostUsdc = feesUsdc + borrowingFeesUsdc + fundingFeesUsdc;

  return {
    trades: allTrades.length,
    feesUsdc,
    borrowingFeesUsdc,
    fundingFeesUsdc,
    netCostUsdc,
    notionalUsd,
    avgFeeRateBps: notionalUsd > 0 ? (netCostUsdc / notionalUsd) * 10000 : 0,
    recentTrades,
  };
}

async function fetchDydxFills(dydxAddress: string, cutoffMs: number): Promise<DydxWalletData> {
  const allFills: Array<{ fee: string; price: string; size: string; liquidity?: string; createdAt: string }> = [];
  // Use createdBeforeOrAt cursor pagination — newest first, no page= param
  // page=N returns oldest-first and breaks the cutoff early-exit logic
  let cursor: string | null = null;
  const limit = 100;

  outer: for (let i = 0; i < 20; i++) {
    const params = new URLSearchParams({
      address: dydxAddress,
      subaccountNumber: "0",
      limit: String(limit),
    });
    if (cursor) params.set("createdBeforeOrAt", cursor);

    const res = await fetch(
      `${DYDX_INDEXER}/v4/fills?${params}`,
      { signal: AbortSignal.timeout(10000), cache: "no-store" }
    );
    if (!res.ok) break;
    const body = (await res.json()) as {
      fills?: Array<{ fee: string; price: string; size: string; liquidity?: string; createdAt: string }>;
    };
    const pageFills = body.fills ?? [];
    if (pageFills.length === 0) break;

    for (const f of pageFills) {
      if (new Date(f.createdAt).getTime() < cutoffMs) break outer;
      allFills.push(f);
    }

    if (pageFills.length < limit) break;
    // Advance cursor to the oldest fill on this page
    cursor = pageFills[pageFills.length - 1].createdAt;
  }

  // Only count taker fills — maker fees are rebates and distort the comparison
  const takers = allFills.filter((f) => (f.liquidity ?? "").toUpperCase() !== "MAKER");
  let feesUsdc = 0;
  let notionalUsd = 0;
  for (const f of takers) {
    feesUsdc += parseFloat(f.fee);
    notionalUsd += parseFloat(f.price) * parseFloat(f.size);
  }

  return {
    fills: takers.length,
    feesUsdc,
    fundingUsd: 0,
    netCostUsdc: feesUsdc,
    notionalUsd,
    avgFeeRateBps: notionalUsd > 0 ? (feesUsdc / notionalUsd) * 10000 : 0,
  };
}

async function fetchGainsTrades(wallet: string, cutoffMs: number): Promise<GainsApiTrade[]> {
  const startDate = new Date(cutoffMs).toISOString();
  const all: GainsApiTrade[] = [];
  let cursor: number | undefined;
  let pages = 0;
  const MAX_PAGES = 6;

  do {
    const params = new URLSearchParams({ chainId: "42161", limit: "100", startDate });
    if (cursor !== undefined) params.set("cursor", String(cursor));

    const res = await fetch(
      `${GAINS_HISTORY_API}/api/personal-trading-history/${wallet}?${params}`,
      { signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) break;
    const body = (await res.json()) as { data: GainsApiTrade[]; pagination: { hasMore: boolean; nextCursor?: number } };
    all.push(...body.data);
    cursor = body.pagination.hasMore ? body.pagination.nextCursor : undefined;
    pages++;
  } while (cursor !== undefined && pages < MAX_PAGES);

  return all;
}

function buildHlWalletData(
  recentFills: HlFill[],
  hlFundingTotal: number
): HlWalletData {
  let hlNotional = 0;
  let hlFees = 0;
  const coinMap: Record<string, { fills: number; notional: number; fees: number }> = {};

  for (const f of recentFills) {
    const notional = parseFloat(f.px) * parseFloat(f.sz);
    const fee = parseFloat(f.fee);
    hlNotional += notional;
    hlFees += fee;
    if (!coinMap[f.coin]) coinMap[f.coin] = { fills: 0, notional: 0, fees: 0 };
    coinMap[f.coin].fills++;
    coinMap[f.coin].notional += notional;
    coinMap[f.coin].fees += fee;
  }

  const topCoins = Object.entries(coinMap)
    .sort((a, b) => b[1].notional - a[1].notional)
    .slice(0, 5)
    .map(([coin, d]) => ({ coin, ...d }));

  const displayFills = recentFills
    .slice()
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_DISPLAY_FILLS)
    .map((f) => ({
      time: f.time,
      coin: f.coin,
      dir: f.dir,
      side: f.side,
      notional: parseFloat(f.px) * parseFloat(f.sz),
      hlFee: parseFloat(f.fee),
      closedPnl: parseFloat(f.closedPnl),
      isTaker: f.crossed,
    }));

  return {
    fills: recentFills.length,
    notionalUsd: hlNotional,
    feesUsd: hlFees,
    fundingUsd: hlFundingTotal,
    netCostUsd: hlFees - hlFundingTotal,
    avgFeeRateBps: hlNotional > 0 ? ((hlFees - hlFundingTotal) / hlNotional) * 10000 : 0,
    topCoins,
    recentFills: displayFills,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Position reconstruction + carry simulation helpers
// ──────────────────────────────────────────────────────────────────────

function reconstructHlPositions(fills: HlFill[], cutoffMs: number): PositionSlice[] {
  const state = new Map<string, { sz: number; openTs: number; openPx: number; isLong: boolean }>();
  const slices: PositionSlice[] = [];
  const sorted = fills.filter((f) => f.time >= cutoffMs).sort((a, b) => a.time - b.time);

  for (const f of sorted) {
    const sz = parseFloat(f.sz);
    const px = parseFloat(f.px);
    const isLong = f.dir.includes("Long");
    const isOpen = f.dir.startsWith("Open");
    const key = `${f.coin}:${isLong ? "L" : "S"}`;

    if (isOpen) {
      const pos = state.get(key) ?? { sz: 0, openTs: f.time, openPx: px, isLong };
      if (pos.sz === 0) { pos.openTs = f.time; pos.openPx = px; }
      pos.sz += sz;
      state.set(key, pos);
    } else {
      const pos = state.get(key);
      if (pos && pos.sz > 0) {
        const closeSz = Math.min(sz, pos.sz);
        slices.push({ coin: f.coin, notionalUsd: closeSz * pos.openPx, openMs: pos.openTs, closeMs: f.time, isLong });
        pos.sz -= closeSz;
        if (pos.sz < 0.00001) state.delete(key);
        else state.set(key, pos);
      }
    }
  }

  // Still-open positions — close at now
  const now = Date.now();
  for (const [key, pos] of state) {
    if (pos.sz > 0.00001) {
      const coin = key.split(":")[0];
      const lastFill = sorted.filter((f) => f.coin === coin).at(-1);
      if (lastFill) {
        slices.push({
          coin,
          notionalUsd: pos.sz * parseFloat(lastFill.px),
          openMs: pos.openTs,
          closeMs: now,
          isLong: pos.isLong,
        });
      }
    }
  }

  return slices;
}

function reconstructGainsPositions(trades: GainsApiTrade[], cutoffMs: number): PositionSlice[] {
  const OPEN_ACTIONS = new Set(["MarketOpened", "LimitOrderExecuted"]);
  const CLOSE_ACTIONS = new Set(["TradeClosedMarket", "TradeClosedTP", "TradeClosedSL", "TradeClosedLIQ"]);

  const byId = new Map<number, { open?: GainsApiTrade; close?: GainsApiTrade }>();
  for (const t of trades) {
    if (!byId.has(t.id)) byId.set(t.id, {});
    const e = byId.get(t.id)!;
    if (OPEN_ACTIONS.has(t.action)) e.open = t;
    else if (CLOSE_ACTIONS.has(t.action)) e.close = t;
  }

  const slices: PositionSlice[] = [];
  for (const { open, close } of byId.values()) {
    if (!open || !close) continue;
    const openMs = new Date(open.date).getTime();
    if (openMs < cutoffMs) continue;
    slices.push({
      coin: open.pair.split("/")[0],
      notionalUsd: open.size * open.leverage,
      openMs,
      closeMs: new Date(close.date).getTime(),
      isLong: open.buy !== false,
    });
  }

  return slices;
}

// Fetch HL 8h funding rate history for a set of coins over a period.
// Returns map of coin → array of { time, rate (as fraction) }.
async function fetchHlFundingHistory(
  coins: string[],
  startMs: number
): Promise<Map<string, Array<{ time: number; rate: number }>>> {
  const results = await Promise.allSettled(
    coins.map(async (coin) => {
      const res = await fetch(HL_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "fundingHistory", coin, startTime: startMs }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [coin, []] as [string, Array<{ time: number; rate: number }>];
      const data = (await res.json()) as Array<{ time: number; fundingRate: string }>;
      return [coin, data.map((d) => ({ time: d.time, rate: parseFloat(d.fundingRate) }))] as [
        string,
        Array<{ time: number; rate: number }>
      ];
    })
  );

  const map = new Map<string, Array<{ time: number; rate: number }>>();
  for (const r of results) {
    if (r.status === "fulfilled") {
      const [coin, rates] = r.value;
      map.set(coin, rates);
    }
  }
  return map;
}

// Compute projected HL funding cost for a set of position slices.
// Uses absolute funding rates so direction doesn't matter for the projection.
function computeHlFunding(
  positions: PositionSlice[],
  history: Map<string, Array<{ time: number; rate: number }>>
): number {
  let total = 0;
  for (const pos of positions) {
    const rates = (history.get(pos.coin) ?? []).filter(
      (r) => r.time >= pos.openMs && r.time <= pos.closeMs
    );
    // Each HL funding entry = one 8h interval. Rate is a fraction applied to notional.
    for (const r of rates) {
      total += pos.notionalUsd * Math.abs(r.rate);
    }
  }
  return total;
}

// Estimate Gains borrowing fees for a set of position slices.
// Uses per-second borrow rate (fraction, 1e18 precision already converted) × notional × duration.
function estimateGainsBorrowFees(
  positions: PositionSlice[],
  borrowPerSecPerCoin: Record<string, number>,
  avgBorrowPerSec: number
): number {
  let total = 0;
  for (const pos of positions) {
    const rate = borrowPerSecPerCoin[pos.coin] ?? avgBorrowPerSec;
    const durationSec = Math.max(0, (pos.closeMs - pos.openMs) / 1000);
    total += pos.notionalUsd * rate * durationSec;
  }
  return total;
}

// Estimate Gains funding fees for a set of position slices.
// Uses the current (last known) per-second funding rate as a proxy for the period.
// Rate is absolute (direction already irrelevant for cost estimation).
function estimateGainsFundingFees(
  positions: PositionSlice[],
  fundingPerSecPerCoin: Record<string, number>
): number {
  let total = 0;
  for (const pos of positions) {
    const rate = fundingPerSecPerCoin[pos.coin];
    if (!rate) continue;
    const durationSec = Math.max(0, (pos.closeMs - pos.openMs) / 1000);
    total += pos.notionalUsd * rate * durationSec;
  }
  return total;
}

// EIP-55 checksum — Subsquid stores addresses in checksummed format
function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace("0x", "");
  const hash = keccak256(lower);
  const result = lower
    .split("")
    .map((c, i) => (parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c))
    .join("");
  return "0x" + result;
}

function walletStats(slug: string, w: AnyWallet): { notional: number; fees: number } | null {
  if (slug === "hyperliquid") {
    const x = w as HlWalletData;
    return x.fills > 0 ? { notional: x.notionalUsd, fees: x.netCostUsd } : null;
  }
  if (slug === "gains") {
    const x = w as GainsWalletData;
    return x.events > 0 ? { notional: x.positionSizeUsdc, fees: x.netCostUsdc } : null;
  }
  if (slug === "gmx-v2") {
    const x = w as GmxWalletData;
    return x.trades > 0 ? { notional: x.notionalUsd, fees: x.netCostUsdc } : null;
  }
  if (slug === "dydx") {
    const x = w as DydxWalletData;
    return x.fills > 0 ? { notional: x.notionalUsd, fees: x.netCostUsdc } : null;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Route
// ──────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const rl = rateLimit(clientKey(req, "fee-compare"), 5, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet")?.trim() ?? "";
  const dydxAddress = url.searchParams.get("dydxAddress")?.trim() ?? "";
  const rawNotional = parseFloat(url.searchParams.get("notional") ?? "0");
  const simNotional = isFinite(rawNotional) && rawNotional > 0 ? Math.min(rawNotional, 1e9) : 0;
  const days = Math.min(
    180,
    Math.max(7, parseInt(url.searchParams.get("days") ?? "90", 10))
  );
  const venueA = (url.searchParams.get("venueA") ?? "hyperliquid").toLowerCase();
  const venueB = (url.searchParams.get("venueB") ?? "gains").toLowerCase();

  if (!VALID_SLUGS.has(venueA) || !VALID_SLUGS.has(venueB)) {
    return NextResponse.json({ error: "invalid_venue" }, { status: 400 });
  }
  if (venueA === venueB) {
    return NextResponse.json({ error: "same_venue" }, { status: 400 });
  }
  if (dydxAddress && !DYDX_ADDRESS_RE.test(dydxAddress)) {
    return NextResponse.json({ error: "invalid_dydx_address" }, { status: 400 });
  }

  const walletProvided = WALLET_RE.test(wallet);
  const dydxProvided = DYDX_ADDRESS_RE.test(dydxAddress);
  const needsEvmWallet = EVM_WALLET_VENUES.has(venueA) || EVM_WALLET_VENUES.has(venueB);
  const needsDydx = venueA === "dydx" || venueB === "dydx";
  const fetchEvmWallet = walletProvided && needsEvmWallet;
  const fetchDydxWallet = dydxProvided && needsDydx;

  const cutoffMs = Date.now() - days * 86400 * 1000;

  try {
    const [
      { rate: rateA, note: noteA, rateIsLive: rateIsLiveA },
      { rate: rateB, note: noteB, rateIsLive: rateIsLiveB },
      gainsData,
    ] = await Promise.all([
      resolveRate(venueA),
      resolveRate(venueB),
      fetchGainsFeeRates(),
    ]);

    let hlFillsData: HlFill[] = [];
    let hlFundingData: HlFundingEvent[] = [];
    let gainsTradesData: GainsApiTrade[] = [];
    let gmxWalletData: GmxWalletData | null = null;
    let dydxWalletData: DydxWalletData | null = null;

    const fetches: Promise<void>[] = [];

    if (fetchEvmWallet) {
      if (venueA === "hyperliquid" || venueB === "hyperliquid") {
        fetches.push(
          fetchHlFills(wallet).then((f) => {
            hlFillsData = f;
          }),
          fetchHlFunding(wallet, cutoffMs).then((f) => {
            hlFundingData = f;
          })
        );
      }
      if (venueA === "gains" || venueB === "gains") {
        fetches.push(
          fetchGainsTrades(wallet, cutoffMs).then((d) => { gainsTradesData = d; }).catch(() => {})
        );
      }
      if (venueA === "gmx-v2" || venueB === "gmx-v2") {
        fetches.push(
          fetchGmxTrades(wallet, cutoffMs)
            .then((d) => {
              gmxWalletData = d;
            })
            .catch(() => {})
        );
      }
    }

    if (fetchDydxWallet) {
      fetches.push(
        fetchDydxFills(dydxAddress, cutoffMs)
          .then((d) => {
            dydxWalletData = d;
          })
          .catch(() => {})
      );
    }

    await Promise.all(fetches);

    // Phase 2: fetch HL funding history for Gains positions (Gains→HL carry projection)
    let hlFundingHistoryByCoins: Map<string, Array<{ time: number; rate: number }>> = new Map();
    if (
      fetchEvmWallet &&
      (venueA === "gains" || venueB === "gains") &&
      (venueA === "hyperliquid" || venueB === "hyperliquid") &&
      gainsTradesData.length > 0
    ) {
      const gainsCoinSet = new Set(
        gainsTradesData
          .filter((t) => t.collateralIndex === 3)
          .map((t) => t.pair.split("/")[0])
      );
      const coinsToFetch = [...gainsCoinSet].slice(0, 6);
      hlFundingHistoryByCoins = await fetchHlFundingHistory(coinsToFetch, cutoffMs).catch(() => new Map());
    }

    function buildVenueResult(slug: string, rate: number, note: string, rateIsLive: boolean): VenueResult {
      let walletData: AnyWallet | null = null;

      if (fetchEvmWallet && slug === "hyperliquid") {
        const recentFills = hlFillsData.filter((f) => f.time >= cutoffMs);
        const recentFunding = hlFundingData.filter((f) => f.time >= cutoffMs);
        const fundingTotal = recentFunding.reduce(
          (s, f) => s + parseFloat(f.delta?.usdc ?? "0"),
          0
        );
        walletData = buildHlWalletData(recentFills, fundingTotal);
        // Annotate each fill with the equivalent fee on the other venue
        const otherSlug = slug === venueA ? venueB : venueA;
        const otherRate = slug === venueA ? rateB : rateA;
        const hlW = walletData as HlWalletData;
        hlW.recentFills = hlW.recentFills.map((fill) => ({
          ...fill,
          equivFee: otherSlug === "gains"
            ? fill.notional * (gainsData.perSide[fill.coin] ?? gainsData.avgPerSide)
            : fill.notional * otherRate,
        }));
      } else if (fetchEvmWallet && slug === "gains") {
        const CLOSE_ACTIONS = new Set(["TradeClosedMarket", "TradeClosedTP", "TradeClosedSL", "TradeClosedLIQ"]);
        const usdcTrades = gainsTradesData.filter((t) => t.collateralIndex === 3);
        let feesUsdc = 0;
        let fundingFeesUsdc = 0;
        let borrowingFeesUsdc = 0;
        let notionalUsd = 0;
        const recentTrades: GainsWalletData["recentTrades"] = [];

        for (const t of usdcTrades) {
          const tradingFee = t.meta?.tradeFeesData?.realizedTradingFeesCollateral ?? 0;
          const isClose = CLOSE_ACTIONS.has(t.action);
          const fundingFee = isClose ? (t.meta?.uiRealizedPnlData?.realizedFundingFeesCollateral ?? 0) : 0;
          const borrowingFee = isClose ? (t.meta?.uiRealizedPnlData?.realizedNewBorrowingFeesCollateral ?? 0) : 0;
          feesUsdc += tradingFee;
          fundingFeesUsdc += fundingFee;
          borrowingFeesUsdc += borrowingFee;
          notionalUsd += t.size * t.leverage;
          if (recentTrades.length < 50) {
            recentTrades.push({ date: t.date, pair: t.pair, action: t.action, notional: t.size * t.leverage, tradingFee, fundingFee, borrowingFee, pnl_net: t.pnl_net });
          }
        }

        // When the API doesn't return per-trade funding (meta absent or zero), fall back to
        // the same per-second rate estimation used in the crossSim projection.
        let fundingEstimated = false;
        if (fundingFeesUsdc >= 0 && fundingFeesUsdc < 0.01 && Object.keys(gainsData.fundingPerSecPerCoin).length > 0) {
          const gainsPositions = reconstructGainsPositions(usdcTrades, cutoffMs);
          const est = estimateGainsFundingFees(gainsPositions, gainsData.fundingPerSecPerCoin);
          if (est > 0.01) {
            fundingFeesUsdc = est;
            fundingEstimated = true;
          }
        }

        const netCostUsdc = feesUsdc + fundingFeesUsdc + borrowingFeesUsdc;
        walletData = {
          events: usdcTrades.length,
          feesUsdc,
          fundingFeesUsdc,
          fundingEstimated,
          borrowingFeesUsdc,
          netCostUsdc,
          positionSizeUsdc: notionalUsd,
          avgFeeRateBps: notionalUsd > 0 ? (netCostUsdc / notionalUsd) * 10000 : 0,
          recentTrades,
        } satisfies GainsWalletData;
      } else if (fetchEvmWallet && slug === "gmx-v2" && gmxWalletData) {
        walletData = gmxWalletData;
      } else if (fetchDydxWallet && slug === "dydx" && dydxWalletData) {
        walletData = dydxWalletData;
      }

      return {
        slug,
        name: VENUE_NAMES[slug] ?? slug,
        ratePerAction: rate,
        rateBps: rate * 10000,
        rateNote: note,
        rateIsLive,
        wallet: walletData,
      };
    }

    const venueAResult = buildVenueResult(venueA, rateA, noteA, rateIsLiveA);
    const venueBResult = buildVenueResult(venueB, rateB, noteB, rateIsLiveB);

    const comparison: ComparisonResult = { aToBSim: null, bToASim: null };

    // aToBSim: venueA actual fills vs simulated venueB cost (with carry projection)
    if (venueAResult.wallet !== null) {
      if (venueA === "hyperliquid" && venueB === "gains") {
        // Per-coin Gains taker rates on HL fills + estimated Gains borrow
        const hlW = venueAResult.wallet as HlWalletData;
        if (hlW.fills > 0) {
          let takerEquiv = 0, aNotional = 0, aFees = 0;
          for (const fill of hlFillsData.filter((f) => f.time >= cutoffMs)) {
            const notional = parseFloat(fill.px) * parseFloat(fill.sz);
            const fee = parseFloat(fill.fee);
            const coinRate = gainsData.perSide[fill.coin] ?? gainsData.avgPerSide;
            takerEquiv += notional * coinRate;
            aNotional += notional;
            aFees += fee;
          }
          const aFunding = hlW.fundingUsd;
          const aNetCost = aFees - aFunding;

          // Estimate Gains carry (borrow + funding) by reconstructing HL positions
          const hlPositions = reconstructHlPositions(hlFillsData, cutoffMs);
          const gainsBorrow = estimateGainsBorrowFees(hlPositions, gainsData.borrowPerSecPerCoin, gainsData.avgBorrowPerSec);
          const gainsFunding = estimateGainsFundingFees(hlPositions, gainsData.fundingPerSecPerCoin);
          const bEquiv = takerEquiv + gainsBorrow + gainsFunding;

          comparison.aToBSim = {
            notionalUsed: aNotional,
            feesActual: aNetCost,
            equivFees: bEquiv,
            saved: bEquiv - aNetCost,
            multiple: aNetCost > 0 ? bEquiv / aNetCost : null,
            fundingUsd: aFunding,
            projectedCarry: {
              takerFees: takerEquiv,
              borrowFees: gainsBorrow,
              fundingFees: gainsFunding,
              borrowProjected: gainsBorrow > 0.01,
              fundingProjected: gainsFunding > 0.01,
            },
          };
          if (aNotional > 0) {
            venueAResult.effectiveRateBps = (aNetCost / aNotional) * 10000;
            venueAResult.effectiveRateNote = `${((aNetCost / aNotional) * 10000).toFixed(2)} bps net (fees + funding)`;
            venueBResult.effectiveRateBps = (bEquiv / aNotional) * 10000;
            venueBResult.effectiveRateNote = `${((bEquiv / aNotional) * 10000).toFixed(2)} bps effective (your coins)`;
          }
        }
      } else {
        const stats = walletStats(venueA, venueAResult.wallet);
        if (stats) {
          let equivFees = stats.notional * rateB;
          let projectedCarry: SimResult["projectedCarry"];

          // Gains→HL: add projected HL funding
          if (venueA === "gains" && venueB === "hyperliquid" && gainsTradesData.length > 0) {
            const positions = reconstructGainsPositions(
              gainsTradesData.filter((t) => t.collateralIndex === 3),
              cutoffMs
            );
            const hlFunding = computeHlFunding(positions, hlFundingHistoryByCoins);
            const takerFees = equivFees;
            equivFees += hlFunding;
            projectedCarry = {
              takerFees,
              borrowFees: 0,
              fundingFees: hlFunding,
              borrowProjected: false,
              fundingProjected: hlFunding > 0.01,
            };
          }

          // HL→GMX: add projected GMX carry using implied rates from the wallet's GMX history
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
          const gmxForA = gmxWalletData as GmxWalletData | null;
          if (venueA === "hyperliquid" && venueB === "gmx-v2" && gmxForA !== null && gmxForA.notionalUsd > 0) {
            const takerFees = equivFees;
            const gmxBorrowRate = gmxForA.borrowingFeesUsdc / gmxForA.notionalUsd;
            const gmxFundingRate = Math.max(0, gmxForA.fundingFeesUsdc) / gmxForA.notionalUsd;
            const gmxBorrowProj = stats.notional * gmxBorrowRate;
            const gmxFundingProj = stats.notional * gmxFundingRate;
            equivFees += gmxBorrowProj + gmxFundingProj;
            projectedCarry = {
              takerFees,
              borrowFees: gmxBorrowProj,
              fundingFees: gmxFundingProj,
              borrowProjected: gmxBorrowProj > 0.01,
              fundingProjected: gmxFundingProj > 0.01,
            };
          }

          comparison.aToBSim = {
            notionalUsed: stats.notional,
            feesActual: stats.fees,
            equivFees,
            saved: equivFees - stats.fees,
            multiple: stats.fees > 0 ? equivFees / stats.fees : null,
            projectedCarry,
          };
          if (stats.notional > 0) {
            venueAResult.effectiveRateBps = (stats.fees / stats.notional) * 10000;
            venueAResult.effectiveRateNote = `${((stats.fees / stats.notional) * 10000).toFixed(2)} bps actual (your fills)`;
            venueBResult.effectiveRateBps = (equivFees / stats.notional) * 10000;
          }
        }
      }
    }

    // bToASim: venueB actual fills vs simulated venueA cost (with carry projection)
    if (venueBResult.wallet !== null) {
      if (venueB === "hyperliquid" && venueA === "gains") {
        // Per-coin Gains taker rates on HL fills + estimated Gains borrow
        const hlW = venueBResult.wallet as HlWalletData;
        if (hlW.fills > 0) {
          let takerEquiv = 0, bNotional = 0, bFees = 0;
          for (const fill of hlFillsData.filter((f) => f.time >= cutoffMs)) {
            const notional = parseFloat(fill.px) * parseFloat(fill.sz);
            const fee = parseFloat(fill.fee);
            const coinRate = gainsData.perSide[fill.coin] ?? gainsData.avgPerSide;
            takerEquiv += notional * coinRate;
            bNotional += notional;
            bFees += fee;
          }
          const bFunding = hlW.fundingUsd;
          const bNetCost = bFees - bFunding;

          const hlPositions = reconstructHlPositions(hlFillsData, cutoffMs);
          const gainsBorrow = estimateGainsBorrowFees(hlPositions, gainsData.borrowPerSecPerCoin, gainsData.avgBorrowPerSec);
          const gainsFunding = estimateGainsFundingFees(hlPositions, gainsData.fundingPerSecPerCoin);
          const aEquiv = takerEquiv + gainsBorrow + gainsFunding;

          comparison.bToASim = {
            notionalUsed: bNotional,
            feesActual: bNetCost,
            equivFees: aEquiv,
            saved: aEquiv - bNetCost,
            multiple: bNetCost > 0 ? aEquiv / bNetCost : null,
            fundingUsd: bFunding,
            projectedCarry: {
              takerFees: takerEquiv,
              borrowFees: gainsBorrow,
              fundingFees: gainsFunding,
              borrowProjected: gainsBorrow > 0.01,
              fundingProjected: gainsFunding > 0.01,
            },
          };
          if (bNotional > 0) {
            venueBResult.effectiveRateBps = (bNetCost / bNotional) * 10000;
            venueBResult.effectiveRateNote = `${((bNetCost / bNotional) * 10000).toFixed(2)} bps net (fees + funding)`;
            venueAResult.effectiveRateBps = (aEquiv / bNotional) * 10000;
            venueAResult.effectiveRateNote = `${((aEquiv / bNotional) * 10000).toFixed(2)} bps effective (your coins)`;
          }
        }
      } else {
        const stats = walletStats(venueB, venueBResult.wallet);
        if (stats) {
          let equivFees = stats.notional * rateA;
          let projectedCarry: SimResult["projectedCarry"];

          // Gains→HL: add projected HL funding
          if (venueB === "gains" && venueA === "hyperliquid" && gainsTradesData.length > 0) {
            const positions = reconstructGainsPositions(
              gainsTradesData.filter((t) => t.collateralIndex === 3),
              cutoffMs
            );
            const hlFunding = computeHlFunding(positions, hlFundingHistoryByCoins);
            const takerFees = equivFees;
            equivFees += hlFunding;
            projectedCarry = {
              takerFees,
              borrowFees: 0,
              fundingFees: hlFunding,
              borrowProjected: false,
              fundingProjected: hlFunding > 0.01,
            };
          }

          // HL→GMX: add projected GMX carry using implied rates from the wallet's GMX history
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
          const gmxForB = gmxWalletData as GmxWalletData | null;
          if (venueB === "hyperliquid" && venueA === "gmx-v2" && gmxForB !== null && gmxForB.notionalUsd > 0) {
            const takerFees = equivFees;
            const gmxBorrowRate = gmxForB.borrowingFeesUsdc / gmxForB.notionalUsd;
            const gmxFundingRate = Math.max(0, gmxForB.fundingFeesUsdc) / gmxForB.notionalUsd;
            const gmxBorrowProj = stats.notional * gmxBorrowRate;
            const gmxFundingProj = stats.notional * gmxFundingRate;
            equivFees += gmxBorrowProj + gmxFundingProj;
            projectedCarry = {
              takerFees,
              borrowFees: gmxBorrowProj,
              fundingFees: gmxFundingProj,
              borrowProjected: gmxBorrowProj > 0.01,
              fundingProjected: gmxFundingProj > 0.01,
            };
          }

          comparison.bToASim = {
            notionalUsed: stats.notional,
            feesActual: stats.fees,
            equivFees,
            saved: equivFees - stats.fees,
            multiple: stats.fees > 0 ? equivFees / stats.fees : null,
            projectedCarry,
          };
          if (stats.notional > 0) {
            venueBResult.effectiveRateBps = (stats.fees / stats.notional) * 10000;
            venueBResult.effectiveRateNote = `${((stats.fees / stats.notional) * 10000).toFixed(2)} bps actual (your fills)`;
            venueAResult.effectiveRateBps = (equivFees / stats.notional) * 10000;
          }
        }
      }
    }

    const simulated = simNotional > 0 ? {
      notional: simNotional,
      aFees: simNotional * rateA,
      bFees: simNotional * rateB,
      saved: Math.abs(simNotional * rateA - simNotional * rateB),
      cheaperSlug: rateA < rateB ? venueA : rateB < rateA ? venueB : null,
    } : null;

    return NextResponse.json({
      wallet: walletProvided ? wallet.toLowerCase() : null,
      dydxAddress: dydxProvided ? dydxAddress : null,
      days,
      generatedAt: Date.now(),
      venueA: venueAResult,
      venueB: venueBResult,
      comparison,
      simulated,
    });
  } catch (err) {
    console.error("[fee-compare]", err);
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }
}
