import { NextResponse } from "next/server";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

const HL_API = "https://api.hyperliquid.xyz/info";
const ARB_RPC = "https://arb1.arbitrum.io/rpc";
const GAINS_DIAMOND_ARB = "0xFF162c694eAA571f685030649814282eA457f169";
const GAINS_VARS_URL = "https://backend-arbitrum.gains.trade/trading-variables";
const FEES_PROCESSED_TOPIC =
  "0x71555a7cc983000fe069574303ed2e47aa16417d297441f6d5e314bd6c58b2fe";

const GAINS_FEE_PRECISION = 1e12;
const HL_TAKER_PER_SIDE = 0.00035;

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const BLOCKS_PER_DAY = 43200;
const MAX_DISPLAY_FILLS = 50;

let gainsFeeCache: { coinRoundTrip: Record<string, number>; ts: number } | null = null;
const GAINS_CACHE_TTL_MS = 60 * 60 * 1000;

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

async function fetchGainsFeeRates(): Promise<Record<string, number>> {
  const now = Date.now();
  if (gainsFeeCache && now - gainsFeeCache.ts < GAINS_CACHE_TTL_MS) {
    return gainsFeeCache.coinRoundTrip;
  }
  const res = await fetch(GAINS_VARS_URL, {
    signal: AbortSignal.timeout(8000),
    next: { revalidate: 3600 },
  });
  const vars = (await res.json()) as GainsTradingVars;
  const coinRoundTrip: Record<string, number> = {};
  for (const p of vars.pairs) {
    if (coinRoundTrip[p.from]) continue;
    const fi = parseInt(p.feeIndex, 10);
    const entry = vars.fees[fi];
    if (!entry) continue;
    const perSide = parseInt(entry.totalPositionSizeFeeP, 10) / GAINS_FEE_PRECISION;
    coinRoundTrip[p.from] = perSide * 2;
  }
  gainsFeeCache = { coinRoundTrip, ts: now };
  return coinRoundTrip;
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
  const walletPadded = "0x" + wallet.replace("0x", "").toLowerCase().padStart(64, "0");
  const logs = (await rpcCall("eth_getLogs", [
    {
      address: GAINS_DIAMOND_ARB,
      topics: [FEES_PROCESSED_TOPIC, null, walletPadded],
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
    },
  ])) as GainsLog[];

  return logs.map((log) => {
    const collateralIndex = parseInt(log.topics[1] ?? "0x0", 16);
    const data = log.data.replace("0x", "");
    if (data.length < 192) return null;
    const posSize = BigInt("0x" + data.slice(0, 64));
    const orderType = parseInt(data.slice(64, 128), 16);
    const totalFees = BigInt("0x" + data.slice(128, 192));
    return { collateralIndex, orderType, posSize, totalFees };
  }).filter(Boolean) as Array<{
    collateralIndex: number; orderType: number; posSize: bigint; totalFees: bigint;
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

export async function GET(req: Request) {
  const rl = rateLimit(clientKey(req, "fee-compare"), 5, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet")?.trim() ?? "";
  const days = Math.min(180, Math.max(7, parseInt(url.searchParams.get("days") ?? "90", 10)));

  if (!WALLET_RE.test(wallet)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }

  const cutoffMs = Date.now() - days * 86400 * 1000;

  try {
    const [hlFills, hlFunding, latestBlock, gainsFeeRates] = await Promise.all([
      fetchHlFills(wallet),
      fetchHlFunding(wallet, cutoffMs),
      getLatestBlock(),
      fetchGainsFeeRates(),
    ]);

    const fromBlock = Math.max(0, latestBlock - Math.ceil(days * BLOCKS_PER_DAY));
    const gainsLogs = await fetchGainsLogs(wallet, fromBlock, latestBlock);

    // ── HL side (100% real data from HL API) ──
    const recentFills = hlFills.filter((f) => f.time >= cutoffMs);
    let hlNotional = 0;
    let hlFees = 0;
    const coinMap: Record<string, { fills: number; notional: number; fees: number; onGains: boolean }> = {};

    for (const f of recentFills) {
      const notional = parseFloat(f.px) * parseFloat(f.sz);
      const fee = parseFloat(f.fee);
      hlNotional += notional;
      hlFees += fee;
      if (!coinMap[f.coin]) coinMap[f.coin] = { fills: 0, notional: 0, fees: 0, onGains: f.coin in gainsFeeRates };
      coinMap[f.coin].fills++;
      coinMap[f.coin].notional += notional;
      coinMap[f.coin].fees += fee;
    }

    const recentFunding = hlFunding.filter((f) => f.time >= cutoffMs);
    const hlFundingTotal = recentFunding.reduce((s, f) => s + parseFloat(f.delta?.usdc ?? "0"), 0);

    // Per-trade display (most recent first, capped)
    const displayFills = recentFills
      .slice()
      .sort((a, b) => b.time - a.time)
      .slice(0, MAX_DISPLAY_FILLS)
      .map((f) => {
        const notional = parseFloat(f.px) * parseFloat(f.sz);
        const hlFee = parseFloat(f.fee);
        const gainsRate = gainsFeeRates[f.coin];
        // Per-side Gains fee for this fill (one leg of the trade)
        const gainsPerSide = gainsRate !== undefined ? notional * (gainsRate / 2) : null;
        return {
          time: f.time,
          coin: f.coin,
          dir: f.dir,
          side: f.side,
          notional,
          hlFee,
          closedPnl: parseFloat(f.closedPnl),
          isTaker: f.crossed,
          gainsPerSide,
        };
      });

    // Top coins
    const topCoins = Object.entries(coinMap)
      .sort((a, b) => b[1].notional - a[1].notional)
      .slice(0, 5)
      .map(([coin, d]) => ({
        coin, ...d,
        gainsRoundTripRate: gainsFeeRates[coin] ?? null,
      }));

    // Gains equivalent for HL trades (per-coin live rates)
    let gainsEquivForHl = 0;
    let hlNotionalOnGains = 0;
    let hlFeesOnGainsCoins = 0;
    for (const [coin, data] of Object.entries(coinMap)) {
      const gainsRate = gainsFeeRates[coin];
      if (gainsRate === undefined) continue;
      gainsEquivForHl += data.notional * gainsRate;
      hlNotionalOnGains += data.notional;
      hlFeesOnGainsCoins += data.fees;
    }

    // ── Gains side ──
    const usdcLogs = gainsLogs.filter((l) => l.collateralIndex === 3);
    const gainsFeesUsdc = usdcLogs.reduce((s, l) => s + Number(l.totalFees) / 1e6, 0);
    const gainsSizeUsdc = usdcLogs.reduce((s, l) => s + Number(l.posSize) / 1e6, 0);

    const hlRoundTrip = HL_TAKER_PER_SIDE * 2;
    const hlEquivForGains = gainsSizeUsdc * hlRoundTrip;

    return NextResponse.json({
      wallet: wallet.toLowerCase(),
      days,
      generatedAt: Date.now(),
      hl: {
        fills: recentFills.length,
        notionalUsd: hlNotional,
        feesUsd: hlFees,
        fundingUsd: hlFundingTotal,
        netCostUsd: hlFees - hlFundingTotal,
        avgFeeRateBps: hlNotional > 0 ? (hlFees / hlNotional) * 10000 : 0,
        topCoins,
        recentFills: displayFills,
      },
      gains: {
        events: usdcLogs.length,
        feesUsdc: gainsFeesUsdc,
        positionSizeUsdc: gainsSizeUsdc,
        avgFeeRateBps: gainsSizeUsdc > 0 ? (gainsFeesUsdc / gainsSizeUsdc) * 10000 : 0,
      },
      comparison: {
        hlNotionalOnGains,
        hlFeesOnGainsCoins,
        gainsEquivForHlNotional: gainsEquivForHl,
        hlSavedVsGains: gainsEquivForHl - hlFeesOnGainsCoins,
        hlCheaperMultiple: hlFeesOnGainsCoins > 0 ? gainsEquivForHl / hlFeesOnGainsCoins : null,
        hlRoundTripRate: hlRoundTrip,
        hlEquivForGainsVolume: hlEquivForGains,
        gainsSavedVsHl: gainsFeesUsdc - hlEquivForGains,
      },
      gainsFeeRates: Object.fromEntries(
        Object.entries(gainsFeeRates).filter(([coin]) => coinMap[coin]?.onGains)
      ),
    });
  } catch (err) {
    console.error("[fee-compare]", err);
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }
}
