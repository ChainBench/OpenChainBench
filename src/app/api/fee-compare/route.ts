import { NextResponse } from "next/server";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { keccak256 } from "js-sha3";

export const runtime = "nodejs";
export const maxDuration = 30;

const HL_API = "https://api.hyperliquid.xyz/info";
const ARB_RPC = "https://arb1.arbitrum.io/rpc";
const GAINS_DIAMOND_ARB = "0xFF162c694eAA571f685030649814282eA457f169";
const GAINS_VARS_URL = "https://backend-arbitrum.gains.trade/trading-variables";
const FEES_PROCESSED_TOPIC =
  "0x71555a7cc983000fe069574303ed2e47aa16417d297441f6d5e314bd6c58b2fe";
const GMX_SUBSQUID = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
const DYDX_INDEXER = "https://indexer.dydx.trade";

const GAINS_FEE_PRECISION = 1e12;
const HL_TAKER_FALLBACK = 0.00035;

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const DYDX_ADDRESS_RE = /^dydx1[a-z0-9]{38}$/;
const BLOCKS_PER_DAY = 43200;
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

let gainsFeeCache: {
  coinRoundTrip: Record<string, number>;
  perSide: Record<string, number>;
  avgPerSide: number;
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

type GainsLog = {
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
};

type GainsTradingVars = {
  pairs: Array<{ from: string; feeIndex: string }>;
  fees: Array<{ totalPositionSizeFeeP: string }>;
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
  positionSizeUsdc: number;
  avgFeeRateBps: number;
};

type GmxWalletData = {
  trades: number;
  feesUsdc: number;
  notionalUsd: number;
  avgFeeRateBps: number;
};

type DydxWalletData = {
  fills: number;
  feesUsdc: number;
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
};

type SimResult = {
  notionalUsed: number;
  feesActual: number;
  equivFees: number;
  saved: number;
  multiple: number | null;
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
}> {
  const now = Date.now();
  if (gainsFeeCache && now - gainsFeeCache.ts < RATE_CACHE_TTL_MS) {
    return {
      coinRoundTrip: gainsFeeCache.coinRoundTrip,
      perSide: gainsFeeCache.perSide,
      avgPerSide: gainsFeeCache.avgPerSide,
    };
  }
  const res = await fetch(GAINS_VARS_URL, {
    signal: AbortSignal.timeout(8000),
    next: { revalidate: 3600 },
  });
  const vars = (await res.json()) as GainsTradingVars;
  const coinRoundTrip: Record<string, number> = {};
  const perSide: Record<string, number> = {};
  for (const p of vars.pairs) {
    if (coinRoundTrip[p.from]) continue;
    const fi = parseInt(p.feeIndex, 10);
    const entry = vars.fees[fi];
    if (!entry) continue;
    const ps = parseInt(entry.totalPositionSizeFeeP, 10) / GAINS_FEE_PRECISION;
    coinRoundTrip[p.from] = ps * 2;
    perSide[p.from] = ps;
  }
  const sides = Object.values(perSide);
  const avgPerSide =
    sides.length > 0 ? sides.reduce((a, b) => a + b, 0) / sides.length : 0.0005;
  gainsFeeCache = { coinRoundTrip, perSide, avgPerSide, ts: now };
  return { coinRoundTrip, perSide, avgPerSide };
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
  const query = `{
    tradeActions(
      where: { positionFeeAmount_isNull: false sizeDeltaUsd_gt: "0" orderType_in: [2, 3, 4] }
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
    totalFees += Number(BigInt(t.positionFeeAmount)) / 1e6;
    totalNotional += Number(BigInt(t.sizeDeltaUsd) / BigInt("1000000000000000000000000")) / 1e6;
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

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(ARB_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const d = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (d.error) throw new Error(`RPC ${method}: ${d.error.message}`);
  return d.result;
}

async function getLatestBlock(): Promise<number> {
  const hex = (await rpcCall("eth_blockNumber", [])) as string;
  return parseInt(hex, 16);
}

async function fetchGainsLogs(wallet: string, fromBlock: number, toBlock: number) {
  const walletPadded =
    "0x" + wallet.replace("0x", "").toLowerCase().padStart(64, "0");
  const logs = (await rpcCall("eth_getLogs", [
    {
      address: GAINS_DIAMOND_ARB,
      topics: [FEES_PROCESSED_TOPIC, null, walletPadded],
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
    },
  ])) as GainsLog[];

  return logs
    .map((log) => {
      const collateralIndex = parseInt(log.topics[1] ?? "0x0", 16);
      const data = log.data.replace("0x", "");
      if (data.length < 192) return null;
      const posSize = BigInt("0x" + data.slice(0, 64));
      const orderType = parseInt(data.slice(64, 128), 16);
      const totalFees = BigInt("0x" + data.slice(128, 192));
      return { collateralIndex, orderType, posSize, totalFees };
    })
    .filter(Boolean) as Array<{
    collateralIndex: number;
    orderType: number;
    posSize: bigint;
    totalFees: bigint;
  }>;
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

async function fetchGmxTrades(wallet: string): Promise<GmxWalletData> {
  const query = `
    query GmxTrades($account: String!) {
      tradeActions(
        where: {
          account_eq: $account
          positionFeeAmount_isNull: false
          sizeDeltaUsd_gt: "0"
          orderType_in: [2, 3, 4]
        }
        orderBy: timestamp_DESC
        limit: 200
      ) {
        sizeDeltaUsd
        positionFeeAmount
        orderType
      }
    }
  `;
  const res = await fetch(GMX_SUBSQUID, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { account: toChecksumAddress(wallet) } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GMX Subsquid ${res.status}`);
  const body = (await res.json()) as {
    data?: {
      tradeActions: Array<{
        sizeDeltaUsd: string;
        positionFeeAmount: string;
        orderType: number;
      }>;
    };
  };
  const trades = body.data?.tradeActions ?? [];

  let feesUsdc = 0;
  let notionalUsd = 0;
  for (const t of trades) {
    feesUsdc += Number(BigInt(t.positionFeeAmount)) / 1e6;
    // sizeDeltaUsd has 30 decimals; divide by 1e24 to get 6-decimal USD, then /1e6
    notionalUsd +=
      Number(BigInt(t.sizeDeltaUsd) / BigInt("1000000000000000000000000")) / 1e6;
  }

  return {
    trades: trades.length,
    feesUsdc,
    notionalUsd,
    avgFeeRateBps: notionalUsd > 0 ? (feesUsdc / notionalUsd) * 10000 : 0,
  };
}

async function fetchDydxFills(dydxAddress: string): Promise<DydxWalletData> {
  const res = await fetch(
    `${DYDX_INDEXER}/v4/fills?address=${encodeURIComponent(dydxAddress)}&subaccountNumber=0&limit=100`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`dYdX indexer ${res.status}`);
  const body = (await res.json()) as {
    fills?: Array<{ fee: string; price: string; size: string; liquidity?: string }>;
  };
  // Keep only taker fills (positive fee)
  const fills = (body.fills ?? []).filter((f) => parseFloat(f.fee) > 0);

  let feesUsdc = 0;
  let notionalUsd = 0;
  for (const f of fills) {
    feesUsdc += parseFloat(f.fee);
    notionalUsd += parseFloat(f.price) * parseFloat(f.size);
  }

  return {
    fills: fills.length,
    feesUsdc,
    notionalUsd,
    avgFeeRateBps: notionalUsd > 0 ? (feesUsdc / notionalUsd) * 10000 : 0,
  };
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
    avgFeeRateBps: hlNotional > 0 ? (hlFees / hlNotional) * 10000 : 0,
    topCoins,
    recentFills: displayFills,
  };
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
    return x.fills > 0 ? { notional: x.notionalUsd, fees: x.feesUsd } : null;
  }
  if (slug === "gains") {
    const x = w as GainsWalletData;
    return x.events > 0 ? { notional: x.positionSizeUsdc, fees: x.feesUsdc } : null;
  }
  if (slug === "gmx-v2") {
    const x = w as GmxWalletData;
    return x.trades > 0 ? { notional: x.notionalUsd, fees: x.feesUsdc } : null;
  }
  if (slug === "dydx") {
    const x = w as DydxWalletData;
    return x.fills > 0 ? { notional: x.notionalUsd, fees: x.feesUsdc } : null;
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
    let gainsLogsData: Array<{
      collateralIndex: number;
      orderType: number;
      posSize: bigint;
      totalFees: bigint;
    }> = [];
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
          getLatestBlock().then(async (latestBlock) => {
            const fromBlock = Math.max(
              0,
              latestBlock - Math.ceil(days * BLOCKS_PER_DAY)
            );
            gainsLogsData = await fetchGainsLogs(wallet, fromBlock, latestBlock);
          })
        );
      }
      if (venueA === "gmx-v2" || venueB === "gmx-v2") {
        fetches.push(
          fetchGmxTrades(wallet)
            .then((d) => {
              gmxWalletData = d;
            })
            .catch(() => {})
        );
      }
    }

    if (fetchDydxWallet) {
      fetches.push(
        fetchDydxFills(dydxAddress)
          .then((d) => {
            dydxWalletData = d;
          })
          .catch(() => {})
      );
    }

    await Promise.all(fetches);

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
        const usdcLogs = gainsLogsData.filter((l) => l.collateralIndex === 3);
        const feesUsdc = usdcLogs.reduce(
          (s, l) => s + Number(l.totalFees) / 1e6,
          0
        );
        const sizeUsdc = usdcLogs.reduce(
          (s, l) => s + Number(l.posSize) / 1e6,
          0
        );
        const gd: GainsWalletData = {
          events: usdcLogs.length,
          feesUsdc,
          positionSizeUsdc: sizeUsdc,
          avgFeeRateBps: sizeUsdc > 0 ? (feesUsdc / sizeUsdc) * 10000 : 0,
        };
        walletData = gd;
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

    // aToBSim: venueA actual fills vs simulated venueB cost
    if (venueAResult.wallet !== null) {
      if (venueA === "hyperliquid" && venueB === "gains") {
        // Per-coin Gains rates on HL fills
        const hlW = venueAResult.wallet as HlWalletData;
        if (hlW.fills > 0) {
          let bEquiv = 0, aNotional = 0, aFees = 0;
          for (const fill of hlFillsData.filter((f) => f.time >= cutoffMs)) {
            const notional = parseFloat(fill.px) * parseFloat(fill.sz);
            const fee = parseFloat(fill.fee);
            const coinRate = gainsData.perSide[fill.coin] ?? gainsData.avgPerSide;
            bEquiv += notional * coinRate;
            aNotional += notional;
            aFees += fee;
          }
          comparison.aToBSim = {
            notionalUsed: aNotional,
            feesActual: aFees,
            equivFees: bEquiv,
            saved: bEquiv - aFees,
            multiple: aFees > 0 ? bEquiv / aFees : null,
          };
        }
      } else {
        const stats = walletStats(venueA, venueAResult.wallet);
        if (stats) {
          const equivFees = stats.notional * rateB;
          comparison.aToBSim = {
            notionalUsed: stats.notional,
            feesActual: stats.fees,
            equivFees,
            saved: equivFees - stats.fees,
            multiple: stats.fees > 0 ? equivFees / stats.fees : null,
          };
        }
      }
    }

    // bToASim: venueB actual fills vs simulated venueA cost
    if (venueBResult.wallet !== null) {
      if (venueB === "hyperliquid" && venueA === "gains") {
        const hlW = venueBResult.wallet as HlWalletData;
        if (hlW.fills > 0) {
          let aEquiv = 0, bNotional = 0, bFees = 0;
          for (const fill of hlFillsData.filter((f) => f.time >= cutoffMs)) {
            const notional = parseFloat(fill.px) * parseFloat(fill.sz);
            const fee = parseFloat(fill.fee);
            const coinRate = gainsData.perSide[fill.coin] ?? gainsData.avgPerSide;
            aEquiv += notional * coinRate;
            bNotional += notional;
            bFees += fee;
          }
          comparison.bToASim = {
            notionalUsed: bNotional,
            feesActual: bFees,
            equivFees: aEquiv,
            saved: bFees - aEquiv,
            multiple: bFees > 0 ? aEquiv / bFees : null,
          };
        }
      } else {
        const stats = walletStats(venueB, venueBResult.wallet);
        if (stats) {
          const equivFees = stats.notional * rateA;
          comparison.bToASim = {
            notionalUsed: stats.notional,
            feesActual: stats.fees,
            equivFees,
            saved: stats.fees - equivFees,
            multiple: stats.fees > 0 ? equivFees / stats.fees : null,
          };
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
