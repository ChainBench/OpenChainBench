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

// GMX v2 on Arbitrum
const ARB_RPC = "https://arb1.arbitrum.io/rpc";
const GMX_DATASTORE = "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8";
const GMX_MARKETS: Record<string, string> = {
  "0x47c031236e19d024b42f8AE6780E44A573170703": "BTC",
  "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336": "ETH",
  "0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9": "SOL",
  "0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407": "ARB",
  "0x7f1fa204bb700853D36994DA19F830b6Ad18d232": "LINK",
  "0x6853EA96FF216fAb11D2d930CE3C508556A4bdc4": "DOGE",
  "0xD9535bB5f58A1a75032416F2dFe7880C30575a41": "XRP",
};
// GMX typical utilization assumption for base borrowing factor
const GMX_AVG_UTILIZATION = 0.4;

const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
// Primary long collateral per GMX v2 market on Arbitrum.
// Real markets use the native token; synthetic markets use WETH.
const GMX_MARKET_LONG_TOKEN: Record<string, string> = {
  "0x47c031236e19d024b42f8AE6780E44A573170703": "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", // BTC → WBTC
  "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // ETH → WETH
  "0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // SOL → WETH (synthetic)
  "0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407": "0x912CE59144191C1204E64559FE8253a0e49E6548", // ARB → ARB
  "0x7f1fa204bb700853D36994DA19F830b6Ad18d232": "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", // LINK → LINK
  "0x6853EA96FF216fAb11D2d930CE3C508556A4bdc4": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // DOGE → WETH (synthetic)
  "0xD9535bB5f58A1a75032416F2dFe7880C30575a41": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // XRP → WETH (synthetic)
};

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

type CarryRates = {
  fundingPerSecPerCoin: Record<string, number>;
  borrowPerSecPerCoin: Record<string, number>;
  ts: number;
};
const carryRateCache: Partial<Record<string, CarryRates>> = {};

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
      realizedOldBorrowingFeesCollateral?: number;
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
  gainsExclusiveFeesUsdc?: number; // fees on coins not available on the other venue
  recentTrades: Array<{
    date: string;
    pair: string;
    action: string;
    notional: number;
    tradingFee: number;
    fundingFee: number;
    borrowingFee: number;
    equivFee?: number;
    hlComparable?: boolean; // false = coin not listed on HL
    pnl_net: number;
  }>;
};

type RawGmxTrade = {
  timestamp: number;
  sizeDeltaUsd: string;
  isLong: boolean;
  positionFeeAmount: string;
  borrowingFeeAmount: string | null;
  fundingFeeAmount: string | null;
  pnlUsd: string | null;
  orderType: number;
  indexToken: { symbol: string } | null;
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
    indexToken?: string;
    orderType?: number;
  }>;
  rawTrades?: RawGmxTrade[];
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

    // Signed funding rate: positive = longs pay shorts, negative = shorts pay longs
    const fundingRate = fundingPairData[i]?.lastFundingRatePerSecondP;
    if (fundingRate) {
      fundingPerSecPerCoin[p.from] = parseFloat(fundingRate) / GAINS_FUNDING_PRECISION;
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

async function fetchDydxCarryRates(): Promise<CarryRates> {
  const cached = carryRateCache["dydx"];
  if (cached && Date.now() - cached.ts < RATE_CACHE_TTL_MS) return cached;
  const res = await fetch(`${DYDX_INDEXER}/v4/perpetualMarkets`, {
    signal: AbortSignal.timeout(8000),
    next: { revalidate: 3600 },
  });
  const data = (await res.json()) as {
    markets: Record<string, { nextFundingRate?: string }>;
  };
  const fundingPerSecPerCoin: Record<string, number> = {};
  for (const [market, info] of Object.entries(data.markets ?? {})) {
    // "BTC-USD" → "BTC", "ETH-USD-PERP" → "ETH"
    const coin = market.replace(/-USD.*/, "");
    // Signed: positive = longs pay shorts, negative = shorts pay longs
    const rate = parseFloat(info.nextFundingRate ?? "0") / 3600;
    if (rate !== 0) fundingPerSecPerCoin[coin] = rate;
  }
  const result: CarryRates = { fundingPerSecPerCoin, borrowPerSecPerCoin: {}, ts: Date.now() };
  carryRateCache["dydx"] = result;
  return result;
}

async function fetchParadexCarryRates(): Promise<CarryRates> {
  const cached = carryRateCache["paradex"];
  if (cached && Date.now() - cached.ts < RATE_CACHE_TTL_MS) return cached;
  const res = await fetch("https://api.prod.paradex.trade/v1/markets", {
    signal: AbortSignal.timeout(8000),
    next: { revalidate: 3600 },
  });
  const data = (await res.json()) as {
    results: Array<{ symbol: string; interest_rate?: string; funding_period_hours?: number | string }>;
  };
  const fundingPerSecPerCoin: Record<string, number> = {};
  for (const mkt of data.results ?? []) {
    if (!mkt.symbol.endsWith("-PERP")) continue;
    // "BTC-USD-PERP" → "BTC"
    const coin = mkt.symbol.replace(/-USD-PERP$/, "").replace(/-PERP$/, "");
    const periodHours = parseFloat(String(mkt.funding_period_hours ?? "8")) || 8;
    const rate = parseFloat(mkt.interest_rate ?? "0") / (periodHours * 3600);
    if (rate > 0) fundingPerSecPerCoin[coin] = rate;
  }
  const result: CarryRates = { fundingPerSecPerCoin, borrowPerSecPerCoin: {}, ts: Date.now() };
  carryRateCache["paradex"] = result;
  return result;
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

// ── GMX v2 carry rates ─────────────────────────────────────────────────

// Compute keccak256("BORROWING_FACTOR") constant (abi.encode of string)
function gmxBorrowingFactorBaseKey(): string {
  // abi.encode(string "BORROWING_FACTOR"):
  // [0..31]  = offset = 0x20 (32)
  // [32..63] = length = 0x10 (16)
  // [64..95] = "BORROWING_FACTOR" padded to 32 bytes
  const enc = new Uint8Array(96);
  enc[31] = 0x20;
  enc[63] = 0x10;
  const content = Buffer.from("BORROWING_FACTOR", "utf8");
  enc.set(content, 64);
  return "0x" + keccak256(Array.from(enc));
}

function computeBorrowingFactorKey(marketAddr: string, isLong: boolean): string {
  const baseKey = gmxBorrowingFactorBaseKey();
  // abi.encode(bytes32, address, bool) = 96 bytes
  const enc = new Uint8Array(96);
  // bytes32 at [0..31]
  const factorBytes = Buffer.from(baseKey.replace("0x", ""), "hex");
  enc.set(factorBytes, 0);
  // address padded to 32: 12 leading zero bytes + 20 addr bytes at [32..63]
  const addrBytes = Buffer.from(marketAddr.replace("0x", "").toLowerCase(), "hex");
  enc.set(addrBytes, 44);
  // bool padded to 32: [95] = 0 or 1
  enc[95] = isLong ? 1 : 0;
  return "0x" + keccak256(Array.from(enc));
}

// keccak256(abi.encode(string)) — shared by all GMX DataStore key bases
function gmxStringBase(str: string): string {
  const enc = new Uint8Array(96);
  enc[31] = 0x20; // offset = 32
  enc[63] = str.length;
  Buffer.from(str, "utf8").copy(Buffer.from(enc.buffer), 64);
  return keccak256(Array.from(enc));
}

// keccak256(abi.encode(FUNDING_FACTOR, market))
function computeFundingFactorKey(marketAddr: string): string {
  const base = gmxStringBase("FUNDING_FACTOR");
  // abi.encode(bytes32, address) = 64 bytes
  const enc = new Uint8Array(64);
  Buffer.from(base, "hex").copy(Buffer.from(enc.buffer), 0);
  Buffer.from(marketAddr.replace("0x", "").toLowerCase(), "hex").copy(Buffer.from(enc.buffer), 44);
  return "0x" + keccak256(Array.from(enc));
}

// keccak256(abi.encode(OPEN_INTEREST, market, collateralToken, isLong))
function computeOpenInterestKey(marketAddr: string, collateralToken: string, isLong: boolean): string {
  const base = gmxStringBase("OPEN_INTEREST");
  // abi.encode(bytes32, address, address, bool) = 128 bytes
  const enc = new Uint8Array(128);
  Buffer.from(base, "hex").copy(Buffer.from(enc.buffer), 0);
  Buffer.from(marketAddr.replace("0x", "").toLowerCase(), "hex").copy(Buffer.from(enc.buffer), 44);
  Buffer.from(collateralToken.replace("0x", "").toLowerCase(), "hex").copy(Buffer.from(enc.buffer), 76);
  enc[127] = isLong ? 1 : 0;
  return "0x" + keccak256(Array.from(enc));
}

async function ethCallGetUint(contract: string, storageKey: string): Promise<bigint> {
  // getUint(bytes32): selector = first 4 bytes of keccak256("getUint(bytes32)")
  const selectorHash = keccak256(Array.from(Buffer.from("getUint(bytes32)", "utf8")));
  const selector = selectorHash.slice(0, 8); // 4 bytes = 8 hex chars
  const keyHex = storageKey.replace("0x", "").padStart(64, "0");
  const calldata = "0x" + selector + keyHex;

  const res = await fetch(ARB_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: contract, data: calldata }, "latest"],
    }),
    signal: AbortSignal.timeout(8000),
  });
  const body = (await res.json()) as { result?: string; error?: unknown };
  if (!body.result || body.result === "0x") return BigInt(0);
  return BigInt(body.result);
}

const GMX_CARRY_FALLBACK: CarryRates = {
  borrowPerSecPerCoin: {
    BTC: 1.4e-8,
    ETH: 1.7e-8,
    SOL: 2.8e-8,
    ARB: 2.0e-8,
    LINK: 2.0e-8,
    DOGE: 1.4e-8,
    XRP: 1.4e-8,
  },
  fundingPerSecPerCoin: {},
  ts: 0,
};

async function fetchGmxCarryRates(): Promise<CarryRates> {
  const cached = carryRateCache["gmx-v2"];
  if (cached && Date.now() - cached.ts < RATE_CACHE_TTL_MS) {
    return { borrowPerSecPerCoin: cached.borrowPerSecPerCoin, fundingPerSecPerCoin: cached.fundingPerSecPerCoin, ts: cached.ts };
  }

  try {
    const borrowPerSecPerCoin: Record<string, number> = {};

    // Fetch borrowing factor for each market (longs only — shorts are similar magnitude)
    const marketEntries = Object.entries(GMX_MARKETS);
    const results = await Promise.allSettled(
      marketEntries.map(async ([market, coin]) => {
        const key = computeBorrowingFactorKey(market, true);
        const raw = await ethCallGetUint(GMX_DATASTORE, key);
        // borrowingFactor is in 1e30 precision; apply average utilization
        const perSec = (Number(raw) / 1e30) * GMX_AVG_UTILIZATION;
        return { coin, perSec };
      })
    );

    let successCount = 0;
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.perSec > 0) {
        borrowPerSecPerCoin[r.value.coin] = r.value.perSec;
        successCount++;
      }
    }

    // If fewer than half the markets returned data, use fallback
    if (successCount < marketEntries.length / 2) {
      const fallback = { ...GMX_CARRY_FALLBACK, ts: Date.now() };
      carryRateCache["gmx-v2"] = fallback;
      return GMX_CARRY_FALLBACK;
    }

    // Fill missing coins from fallback
    for (const [coin, rate] of Object.entries(GMX_CARRY_FALLBACK.borrowPerSecPerCoin)) {
      if (!borrowPerSecPerCoin[coin]) borrowPerSecPerCoin[coin] = rate;
    }

    // Funding rates: 3 DataStore reads per market (fundingFactor + longsOI + shortsOI)
    const fundingPerSecPerCoin: Record<string, number> = {};
    const fundingReads = await Promise.allSettled(
      Object.entries(GMX_MARKETS).map(async ([marketAddr, coin]) => {
        const longToken = GMX_MARKET_LONG_TOKEN[marketAddr];
        if (!longToken) return null;

        const [fundingFactorRaw, longsOILong, longsOIShort, shortsOIShort, shortsOILong] = await Promise.all([
          ethCallGetUint(GMX_DATASTORE, computeFundingFactorKey(marketAddr)),
          // OI is tracked per collateral token; sum both to get total side OI
          ethCallGetUint(GMX_DATASTORE, computeOpenInterestKey(marketAddr, longToken, true)),
          ethCallGetUint(GMX_DATASTORE, computeOpenInterestKey(marketAddr, USDC_ARB, true)),
          ethCallGetUint(GMX_DATASTORE, computeOpenInterestKey(marketAddr, USDC_ARB, false)),
          ethCallGetUint(GMX_DATASTORE, computeOpenInterestKey(marketAddr, longToken, false)),
        ]);

        const longsOI = longsOILong + longsOIShort;
        const shortsOI = shortsOIShort + shortsOILong;
        const totalOI = longsOI + shortsOI;

        if (totalOI === BigInt(0) || fundingFactorRaw === BigInt(0)) return { coin, rate: 0 };

        const imbalance = longsOI > shortsOI ? longsOI - shortsOI : shortsOI - longsOI;
        // rate = fundingFactor × (imbalance / totalOI) / 1e30
        const rateScaled = fundingFactorRaw * imbalance / totalOI;
        const rate = Number(rateScaled) / 1e30;

        return { coin, rate };
      })
    );

    for (const r of fundingReads) {
      if (r.status !== "fulfilled" || !r.value) continue;
      const { coin, rate } = r.value;
      // Sanity check: GMX funding should be between 1e-12 and 1e-6 /sec
      if (rate > 1e-12 && rate < 1e-6) {
        fundingPerSecPerCoin[coin] = rate;
      }
    }

    const result: CarryRates = { borrowPerSecPerCoin, fundingPerSecPerCoin, ts: Date.now() };
    carryRateCache["gmx-v2"] = { ...result, ts: Date.now() };
    return result;
  } catch {
    const fallback = { ...GMX_CARRY_FALLBACK, ts: Date.now() };
    carryRateCache["gmx-v2"] = fallback;
    return GMX_CARRY_FALLBACK;
  }
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

type HlOpenPos = {
  coin: string;
  szi: string;
  entryPx: string;
  positionValue: string;
};

async function fetchHlOpenPositions(wallet: string): Promise<HlOpenPos[]> {
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: wallet }),
    signal: AbortSignal.timeout(8000),
  });
  const data = (await res.json()) as {
    assetPositions?: Array<{ position: HlOpenPos }>;
  };
  return (data.assetPositions ?? [])
    .map((p) => p.position)
    .filter((p) => Math.abs(parseFloat(p.szi)) > 0.000001);
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
  const allTrades: RawGmxTrade[] = [];
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
              orderType
              indexToken { symbol }
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
          edges: Array<{ node: RawGmxTrade }>;
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
      recentTrades.push({
        timestamp: t.timestamp,
        sizeDeltaUsd: notional,
        isLong: t.isLong,
        tradingFee,
        borrowingFee,
        fundingFee,
        pnlUsd,
        indexToken: t.indexToken?.symbol,
        orderType: t.orderType,
      });
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
    rawTrades: allTrades,
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
  // Process ALL fills chronologically so positions opened before cutoffMs are visible
  const sorted = fills.slice().sort((a, b) => a.time - b.time);

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
        // Cap slice start to cutoffMs so carry is only for the measurement window
        const sliceOpen = Math.max(pos.openTs, cutoffMs);
        const sliceClose = f.time;
        if (sliceClose > cutoffMs) {
          slices.push({ coin: f.coin, notionalUsd: closeSz * pos.openPx, openMs: sliceOpen, closeMs: sliceClose, isLong });
        }
        pos.sz -= closeSz;
        if (pos.sz < 0.00001) state.delete(key);
        else state.set(key, pos);
      }
    }
  }

  // Still-open positions — close at now, cap open to cutoffMs
  const now = Date.now();
  for (const [key, pos] of state) {
    if (pos.sz > 0.00001) {
      const coin = key.split(":")[0];
      const lastFill = sorted.filter((f) => f.coin === coin).at(-1);
      if (lastFill) {
        slices.push({
          coin,
          notionalUsd: pos.sz * parseFloat(lastFill.px),
          openMs: Math.max(pos.openTs, cutoffMs),
          closeMs: now,
          isLong: pos.isLong,
        });
      }
    }
  }

  return slices;
}

// Inject currently-open HL positions not captured by the 2000-fill API cap.
// For each open position not already in slices (keyed by coin:side), add a slice
// from cutoffMs to now using the current positionValue as notional.
function augmentWithHlOpenPositions(
  slices: PositionSlice[],
  openPositions: HlOpenPos[],
  cutoffMs: number
): PositionSlice[] {
  const now = Date.now();
  // Coins already tracked as still-open in the fill reconstruction
  const tracked = new Set<string>();
  for (const s of slices) {
    if (s.closeMs >= now - 5 * 60 * 1000) {
      tracked.add(`${s.coin}:${s.isLong ? "L" : "S"}`);
    }
  }
  for (const pos of openPositions) {
    const sz = parseFloat(pos.szi);
    if (!sz) continue;
    const isLong = sz > 0;
    const key = `${pos.coin}:${isLong ? "L" : "S"}`;
    if (tracked.has(key)) continue;
    const notionalUsd = Math.abs(parseFloat(pos.positionValue));
    if (notionalUsd < 1) continue;
    slices.push({ coin: pos.coin, notionalUsd, openMs: cutoffMs, closeMs: now, isLong });
  }
  return slices;
}

function reconstructGainsPositions(trades: GainsApiTrade[], cutoffMs: number): PositionSlice[] {
  // v5 names: MarketOpened, LimitOrderExecuted — v6 names: TradeOpenedMarket, TradeOpenedLimit
  const OPEN_ACTIONS = new Set(["MarketOpened", "LimitOrderExecuted", "TradeOpenedMarket", "TradeOpenedLimit"]);
  // TradePosSizeIncrease updates the position size; use latest size as notional
  const INCREASE_ACTIONS = new Set(["TradePosSizeIncrease"]);
  const CLOSE_ACTIONS = new Set(["TradeClosedMarket", "TradeClosedTP", "TradeClosedSL", "TradeClosedLIQ"]);

  const byId = new Map<number, { open?: GainsApiTrade; close?: GainsApiTrade; lastIncrease?: GainsApiTrade }>();
  for (const t of trades) {
    if (!byId.has(t.id)) byId.set(t.id, {});
    const e = byId.get(t.id)!;
    if (OPEN_ACTIONS.has(t.action)) e.open = t;
    else if (INCREASE_ACTIONS.has(t.action)) {
      if (e.open) e.open = { ...e.open, size: t.size, leverage: t.leverage };
      // Track increases for positions opened before the window (no open event in data)
      else if (!e.lastIncrease || new Date(t.date).getTime() < new Date(e.lastIncrease.date).getTime()) {
        e.lastIncrease = t;
      }
    }
    else if (CLOSE_ACTIONS.has(t.action)) e.close = t;
  }

  const now = Date.now();
  const slices: PositionSlice[] = [];
  for (const { open, close, lastIncrease } of byId.values()) {
    // Use open event if available; fall back to earliest increase in the window
    // for positions opened before the fetch window (open event not in data).
    const anchor = open ?? lastIncrease;
    if (!anchor) continue;
    const rawOpenMs = new Date(anchor.date).getTime();
    const closeMs = close ? new Date(close.date).getTime() : now;
    // Skip positions that closed before the analysis window
    if (closeMs < cutoffMs) continue;
    // Cap openMs to the window start so long-running positions aren't missed
    const openMs = Math.max(rawOpenMs, cutoffMs);
    slices.push({
      coin: anchor.pair.split("/")[0],
      notionalUsd: anchor.size * anchor.leverage,
      openMs,
      closeMs,
      isLong: anchor.buy !== false,
    });
  }

  return slices;
}

// orderType: 2=MarketIncrease, 3=LimitIncrease, 4=MarketDecrease, 5=LimitDecrease, 6=StopLoss, 7=Liquidation
const GMX_INCREASE_TYPES = new Set([2, 3]);
const GMX_DECREASE_TYPES = new Set([4, 5, 6, 7]);

function reconstructGmxPositions(rawTrades: RawGmxTrade[], cutoffMs: number): PositionSlice[] {
  const cutoffSec = cutoffMs / 1000;
  // Sort ascending by timestamp
  const sorted = rawTrades
    .filter((t) => t.timestamp >= cutoffSec)
    .sort((a, b) => a.timestamp - b.timestamp);

  // State: key = coin:L or coin:S → current running notional and open time
  const state = new Map<string, { notionalUsd: number; openMs: number }>();
  const slices: PositionSlice[] = [];

  for (const t of sorted) {
    const coin = t.indexToken?.symbol ?? "UNKNOWN";
    const isLong = t.isLong;
    const key = `${coin}:${isLong ? "L" : "S"}`;
    const notionalDelta =
      Number(BigInt(t.sizeDeltaUsd) / BigInt("1000000000000000000000000")) / 1e6;
    const tradeMs = t.timestamp * 1000;

    if (GMX_INCREASE_TYPES.has(t.orderType)) {
      const existing = state.get(key);
      if (existing) {
        existing.notionalUsd += notionalDelta;
      } else {
        state.set(key, { notionalUsd: notionalDelta, openMs: tradeMs });
      }
    } else if (GMX_DECREASE_TYPES.has(t.orderType)) {
      const existing = state.get(key);
      if (existing && existing.notionalUsd > 0) {
        const closedNotional = Math.min(notionalDelta, existing.notionalUsd);
        slices.push({
          coin,
          notionalUsd: closedNotional,
          openMs: Math.max(existing.openMs, cutoffMs),
          closeMs: tradeMs,
          isLong,
        });
        existing.notionalUsd -= closedNotional;
        if (existing.notionalUsd < 0.01) state.delete(key);
      }
    }
  }

  // Still-open positions closed at now
  const now = Date.now();
  for (const [key, pos] of state) {
    if (pos.notionalUsd > 0.01) {
      const [coin, side] = key.split(":");
      slices.push({
        coin,
        notionalUsd: pos.notionalUsd,
        openMs: Math.max(pos.openMs, cutoffMs),
        closeMs: now,
        isLong: side === "L",
      });
    }
  }

  return slices;
}

// Estimate GMX borrow fees for a set of position slices.
function estimateGmxBorrowFees(
  positions: PositionSlice[],
  borrowPerSecPerCoin: Record<string, number>
): number {
  const fallbackRate = borrowPerSecPerCoin["BTC"] ?? 1.4e-8;
  let total = 0;
  for (const pos of positions) {
    const rate = borrowPerSecPerCoin[pos.coin] ?? fallbackRate;
    const durationSec = Math.max(0, (pos.closeMs - pos.openMs) / 1000);
    total += pos.notionalUsd * rate * durationSec;
  }
  return total;
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
// Returns signed net: positive = wallet pays, negative = wallet receives.
// Rate > 0 = longs pay; < 0 = shorts pay (HL convention).
function computeHlFunding(
  positions: PositionSlice[],
  history: Map<string, Array<{ time: number; rate: number }>>
): number {
  let total = 0;
  for (const pos of positions) {
    const rates = (history.get(pos.coin) ?? []).filter(
      (r) => r.time >= pos.openMs && r.time <= pos.closeMs
    );
    for (const r of rates) {
      // positive cost = this position is on the paying side
      const cost = pos.isLong ? r.rate : -r.rate;
      total += pos.notionalUsd * cost;
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
    // positive rate = longs pay; negative rate = shorts pay
    const effectiveRate = pos.isLong ? Math.max(0, rate) : Math.max(0, -rate);
    total += pos.notionalUsd * effectiveRate * durationSec;
  }
  return total;
}

function estimateCarryFees(
  positions: PositionSlice[],
  rates: { fundingPerSecPerCoin: Record<string, number>; borrowPerSecPerCoin: Record<string, number> }
): { borrowFees: number; fundingFees: number } {
  let borrowFees = 0;
  let fundingFees = 0;
  for (const pos of positions) {
    const durationSec = Math.max(0, (pos.closeMs - pos.openMs) / 1000);
    borrowFees += pos.notionalUsd * (rates.borrowPerSecPerCoin[pos.coin] ?? 0) * durationSec;
    const fundingRate = rates.fundingPerSecPerCoin[pos.coin] ?? 0;
    // positive rate = longs pay; negative rate = shorts pay
    const fundingCost = pos.isLong ? Math.max(0, fundingRate) : Math.max(0, -fundingRate);
    fundingFees += pos.notionalUsd * fundingCost * durationSec;
  }
  return { borrowFees, fundingFees };
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

function walletStats(slug: string, w: AnyWallet, otherSlug?: string): { notional: number; fees: number } | null {
  if (slug === "hyperliquid") {
    const x = w as HlWalletData;
    return x.fills > 0 ? { notional: x.notionalUsd, fees: x.netCostUsd } : null;
  }
  if (slug === "gains") {
    const x = w as GainsWalletData;
    // When comparing against HL, exclude fees on coins not available on HL
    const exclusiveFees = otherSlug === "hyperliquid" ? (x.gainsExclusiveFeesUsdc ?? 0) : 0;
    return x.events > 0 ? { notional: x.positionSizeUsdc, fees: x.netCostUsdc - exclusiveFees } : null;
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
      dydxCarryData,
      paradexCarryData,
      gmxCarryData,
    ] = await Promise.all([
      resolveRate(venueA),
      resolveRate(venueB),
      fetchGainsFeeRates(),
      fetchDydxCarryRates().catch(() => ({ fundingPerSecPerCoin: {}, borrowPerSecPerCoin: {}, ts: 0 } as CarryRates)),
      fetchParadexCarryRates().catch(() => ({ fundingPerSecPerCoin: {}, borrowPerSecPerCoin: {}, ts: 0 } as CarryRates)),
      fetchGmxCarryRates().catch(() => GMX_CARRY_FALLBACK),
    ]);

    function getVenueCarryRates(slug: string): CarryRates {
      if (slug === "gains") return { borrowPerSecPerCoin: gainsData.borrowPerSecPerCoin, fundingPerSecPerCoin: gainsData.fundingPerSecPerCoin, ts: 0 };
      if (slug === "dydx") return dydxCarryData;
      if (slug === "paradex") return paradexCarryData;
      if (slug === "gmx-v2") return gmxCarryData;
      return { borrowPerSecPerCoin: {}, fundingPerSecPerCoin: {}, ts: 0 };
    }

    let hlFillsData: HlFill[] = [];
    let hlFundingData: HlFundingEvent[] = [];
    let hlOpenPositions: HlOpenPos[] = [];
    let hlAvailableCoins = new Set<string>();
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
          }),
          // clearinghouseState gives currently-open positions whose fill may be outside
          // the 2000-fill API cap — without this, long-held positions are invisible to
          // the carry projection even though they generate real HL funding payments.
          fetchHlOpenPositions(wallet).then((p) => {
            hlOpenPositions = p;
          }).catch(() => {})
        );
      }
      if (venueA === "gains" || venueB === "gains") {
        fetches.push(
          fetchGainsTrades(wallet, cutoffMs).then((d) => { gainsTradesData = d; }).catch(() => {})
        );
        if (venueA === "hyperliquid" || venueB === "hyperliquid") {
          fetches.push(
            fetch(HL_API, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "meta" }),
              signal: AbortSignal.timeout(5000),
            })
              .then((r) => r.json())
              .then((d: { universe: Array<{ name: string }> }) => {
                hlAvailableCoins = new Set(d.universe.map((c) => c.name));
              })
              .catch(() => {})
          );
        }
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

    // Phase 2: fetch HL funding history + extended Gains history for position reconstruction
    let hlFundingHistoryByCoins: Map<string, Array<{ time: number; rate: number }>> = new Map();
    // Extended Gains history (1 year) used only for HL funding projection reconstruction —
    // the fee accounting (taker/borrow/funding fees) still uses gainsTradesData (cutoffMs window).
    let gainsPositionData: GainsApiTrade[] = gainsTradesData;
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
      const extendedCutoffMs = cutoffMs - 365 * 24 * 60 * 60 * 1000;
      const [fundingHistory, extendedTrades] = await Promise.all([
        fetchHlFundingHistory(coinsToFetch, cutoffMs).catch(() => new Map<string, Array<{ time: number; rate: number }>>()),
        fetchGainsTrades(wallet, extendedCutoffMs).catch(() => gainsTradesData),
      ]);
      hlFundingHistoryByCoins = fundingHistory;
      gainsPositionData = extendedTrades;
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
        const otherSlug = slug === venueA ? venueB : venueA;
        const otherRate = slug === venueA ? rateB : rateA;
        let feesUsdc = 0;
        let fundingFeesUsdc = 0;
        let borrowingFeesUsdc = 0;
        let notionalUsd = 0;
        let gainsExclusiveFeesUsdc = 0;
        const checkHlComparable = otherSlug === "hyperliquid" && hlAvailableCoins.size > 0;
        const recentTrades: GainsWalletData["recentTrades"] = [];

        for (const t of usdcTrades) {
          // Gains settles carry (funding + borrowing) on every action, not just closes.
          // uiRealizedPnlData breaks down taker, funding, and borrowing separately — use it for all.
          const takerFee = t.meta?.uiRealizedPnlData?.realizedTradingFeesCollateral
            ?? t.meta?.tradeFeesData?.realizedTradingFeesCollateral ?? 0;
          const fundingFee = t.meta?.uiRealizedPnlData?.realizedFundingFeesCollateral ?? 0;
          const borrowingFee = (t.meta?.uiRealizedPnlData?.realizedNewBorrowingFeesCollateral ?? 0)
            + (t.meta?.uiRealizedPnlData?.realizedOldBorrowingFeesCollateral ?? 0);
          feesUsdc += takerFee;
          fundingFeesUsdc += fundingFee;
          borrowingFeesUsdc += borrowingFee;
          const tradeNotional = t.size * t.leverage;
          notionalUsd += tradeNotional;
          const coin = t.pair.split("/")[0];
          const hlComparable = checkHlComparable ? hlAvailableCoins.has(coin) : undefined;
          if (hlComparable === false) {
            gainsExclusiveFeesUsdc += takerFee + fundingFee + borrowingFee;
          }
          if (recentTrades.length < 50) {
            // Don't show equivFee for Gains-exclusive coins — the coin doesn't exist on HL
            const equivFee = hlComparable === false
              ? undefined
              : otherSlug === "hyperliquid"
                ? tradeNotional * (gainsData.perSide[coin] ?? otherRate)
                : tradeNotional * otherRate;
            recentTrades.push({ date: t.date, pair: t.pair, action: t.action, notional: tradeNotional, tradingFee: takerFee, fundingFee, borrowingFee, equivFee, hlComparable, pnl_net: t.pnl_net });
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
          gainsExclusiveFeesUsdc: checkHlComparable ? gainsExclusiveFeesUsdc : undefined,
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

          // Estimate Gains carry (borrow + funding) by reconstructing HL positions.
          // augmentWithHlOpenPositions fills in positions whose open fill is older than the
          // 2000-fill API cap — they still generate real HL funding but are invisible to
          // fill-only reconstruction.
          const hlPositions = augmentWithHlOpenPositions(
            reconstructHlPositions(hlFillsData, cutoffMs),
            hlOpenPositions,
            cutoffMs
          );
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
        const stats = walletStats(venueA, venueAResult.wallet, venueB);
        if (stats) {
          let equivFees = stats.notional * rateB;
          let projectedCarry: SimResult["projectedCarry"];

          // Reconstruct positions from venueA for carry projection
          let positions: PositionSlice[] = [];
          if (venueA === "hyperliquid" && hlFillsData.length > 0) {
            positions = augmentWithHlOpenPositions(
              reconstructHlPositions(hlFillsData, cutoffMs),
              hlOpenPositions,
              cutoffMs
            );
          } else if (venueA === "gains" && gainsPositionData.length > 0) {
            positions = reconstructGainsPositions(
              gainsPositionData.filter((t) => t.collateralIndex === 3),
              cutoffMs
            );
          } else if (venueA === "gmx-v2" && gmxWalletData) {
            const gmxD = gmxWalletData as GmxWalletData;
            if (gmxD.rawTrades) positions = reconstructGmxPositions(gmxD.rawTrades, cutoffMs);
          }

          // Gains→HL: use actual HL funding history (more accurate than rate snapshot)
          if (venueA === "gains" && venueB === "hyperliquid" && positions.length > 0) {
            const hlFunding = computeHlFunding(positions, hlFundingHistoryByCoins);
            const takerFees = equivFees;
            equivFees += hlFunding;
            projectedCarry = {
              takerFees,
              borrowFees: 0,
              fundingFees: hlFunding,
              borrowProjected: false,
              fundingProjected: Math.abs(hlFunding) > 0.01,
            };
          }

          // HL→GMX: use wallet's own GMX history as carry proxy
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

          // Generic carry: dYdX, Paradex, and any future venue with rate data
          if (!projectedCarry && positions.length > 0) {
            const bCarry = getVenueCarryRates(venueB);
            const { borrowFees, fundingFees } = estimateCarryFees(positions, bCarry);
            if (borrowFees > 0.001 || fundingFees > 0.001) {
              const takerFees = equivFees;
              equivFees += borrowFees + fundingFees;
              projectedCarry = {
                takerFees,
                borrowFees,
                fundingFees,
                borrowProjected: borrowFees > 0.01,
                fundingProjected: fundingFees > 0.01,
              };
            }
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

          const hlPositions = augmentWithHlOpenPositions(
            reconstructHlPositions(hlFillsData, cutoffMs),
            hlOpenPositions,
            cutoffMs
          );
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
        const stats = walletStats(venueB, venueBResult.wallet, venueA);
        if (stats) {
          let equivFees = stats.notional * rateA;
          let projectedCarry: SimResult["projectedCarry"];

          // Reconstruct positions from venueB
          let positions: PositionSlice[] = [];
          if (venueB === "hyperliquid" && hlFillsData.length > 0) {
            positions = augmentWithHlOpenPositions(
              reconstructHlPositions(hlFillsData, cutoffMs),
              hlOpenPositions,
              cutoffMs
            );
          } else if (venueB === "gains" && gainsPositionData.length > 0) {
            positions = reconstructGainsPositions(
              gainsPositionData.filter((t) => t.collateralIndex === 3),
              cutoffMs
            );
          } else if (venueB === "gmx-v2" && gmxWalletData) {
            const gmxD = gmxWalletData as GmxWalletData;
            if (gmxD.rawTrades) positions = reconstructGmxPositions(gmxD.rawTrades, cutoffMs);
          }

          // Gains→HL (venueB=gains, venueA=HL)
          if (venueB === "gains" && venueA === "hyperliquid" && positions.length > 0) {
            const hlFunding = computeHlFunding(positions, hlFundingHistoryByCoins);
            const takerFees = equivFees;
            equivFees += hlFunding;
            projectedCarry = {
              takerFees,
              borrowFees: 0,
              fundingFees: hlFunding, // signed: positive = pays, negative = receives
              borrowProjected: false,
              fundingProjected: Math.abs(hlFunding) > 0.01,
            };
          }

          // HL→GMX (venueB=HL, venueA=GMX)
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

          // Generic carry projection
          if (!projectedCarry && positions.length > 0) {
            const aCarry = getVenueCarryRates(venueA);
            const { borrowFees, fundingFees } = estimateCarryFees(positions, aCarry);
            if (borrowFees > 0.001 || fundingFees > 0.001) {
              const takerFees = equivFees;
              equivFees += borrowFees + fundingFees;
              projectedCarry = {
                takerFees,
                borrowFees,
                fundingFees,
                borrowProjected: borrowFees > 0.01,
                fundingProjected: fundingFees > 0.01,
              };
            }
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
