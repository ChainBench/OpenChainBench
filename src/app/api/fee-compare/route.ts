import { NextResponse } from "next/server";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

const HL_API = "https://api.hyperliquid.xyz/info";
const ARB_RPC = "https://arb1.arbitrum.io/rpc";
const GAINS_DIAMOND_ARB = "0xFF162c694eAA571f685030649814282eA457f169";
// keccak256("FeesProcessed(uint8,address,uint256,uint8,uint256)")
const FEES_PROCESSED_TOPIC =
  "0x71555a7cc983000fe069574303ed2e47aa16417d297441f6d5e314bd6c58b2fe";

// 0.12% round-trip (0.06% open + 0.06% close, BTC feeIndex=13 = 600_000_000 / 1e10)
const GAINS_ROUND_TRIP_BPS = 12;
// ~0.045% blended: taker 0.035%×2 or maker 0.01%×2
const HL_ROUND_TRIP_BPS = 4.5;

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const BLOCKS_PER_DAY = 43200; // ~2s blocks on Arbitrum

type HlFill = {
  coin: string;
  px: string;
  sz: string;
  fee: string;
  time: number;
  side: string;
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

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(ARB_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const d = (await res.json()) as {
    result?: unknown;
    error?: { message: string };
  };
  if (d.error) throw new Error(`RPC ${method}: ${d.error.message}`);
  return d.result;
}

async function getLatestBlock(): Promise<number> {
  const hex = (await rpcCall("eth_blockNumber", [])) as string;
  return parseInt(hex, 16);
}

async function fetchGainsLogs(
  wallet: string,
  fromBlock: number,
  toBlock: number,
) {
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
      // topic[1] = collateralIndex (indexed uint8)
      const collateralIndex = parseInt(log.topics[1] ?? "0x0", 16);
      // data = abi.encode(positionSizeCollateral uint256, orderType uint8, totalFeesCollateral uint256)
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

async function fetchHlFunding(
  wallet: string,
  startMs: number,
): Promise<HlFundingEvent[]> {
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
  const days = Math.min(
    180,
    Math.max(7, parseInt(url.searchParams.get("days") ?? "90", 10)),
  );

  if (!WALLET_RE.test(wallet)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }

  const cutoffMs = Date.now() - days * 86400 * 1000;

  try {
    const [hlFills, hlFunding, latestBlock] = await Promise.all([
      fetchHlFills(wallet),
      fetchHlFunding(wallet, cutoffMs),
      getLatestBlock(),
    ]);

    const fromBlock = Math.max(0, latestBlock - Math.ceil(days * BLOCKS_PER_DAY));
    const gainsLogs = await fetchGainsLogs(wallet, fromBlock, latestBlock);

    // ── HL side ──
    const recentFills = hlFills.filter((f) => f.time >= cutoffMs);
    let hlNotional = 0;
    let hlFees = 0;
    const coinMap: Record<
      string,
      { fills: number; notional: number; fees: number }
    > = {};
    for (const f of recentFills) {
      const notional = parseFloat(f.px) * parseFloat(f.sz);
      const fee = parseFloat(f.fee);
      hlNotional += notional;
      hlFees += fee;
      if (!coinMap[f.coin])
        coinMap[f.coin] = { fills: 0, notional: 0, fees: 0 };
      coinMap[f.coin].fills++;
      coinMap[f.coin].notional += notional;
      coinMap[f.coin].fees += fee;
    }

    const recentFunding = hlFunding.filter((f) => f.time >= cutoffMs);
    const hlFundingTotal = recentFunding.reduce(
      (s, f) => s + parseFloat(f.delta?.usdc ?? "0"),
      0,
    );

    const topCoins = Object.entries(coinMap)
      .sort((a, b) => b[1].notional - a[1].notional)
      .slice(0, 5)
      .map(([coin, d]) => ({ coin, ...d }));

    // ── Gains side (USDC collateral = index 3, 6 decimals) ──
    const usdcLogs = gainsLogs.filter((l) => l.collateralIndex === 3);
    const gainsFeesUsdc = usdcLogs.reduce(
      (s, l) => s + Number(l.totalFees) / 1e6,
      0,
    );
    const gainsSizeUsdc = usdcLogs.reduce(
      (s, l) => s + Number(l.posSize) / 1e6,
      0,
    );

    // ── Comparison ──
    // "If the HL trader had been on Gains instead": apply Gains rate to their HL notional
    const gainsEquivForHl = (hlNotional * GAINS_ROUND_TRIP_BPS) / 10000;
    // "If the Gains trader had been on HL instead": apply HL rate to their Gains volume
    const hlEquivForGains = (gainsSizeUsdc * HL_ROUND_TRIP_BPS) / 10000;
    // HL net cost = fees minus funding received (if short and got paid)
    const hlNetCost = hlFees - hlFundingTotal;

    return NextResponse.json({
      wallet: wallet.toLowerCase(),
      days,
      generatedAt: Date.now(),
      hl: {
        fills: recentFills.length,
        notionalUsd: hlNotional,
        feesUsd: hlFees,
        fundingUsd: hlFundingTotal,
        netCostUsd: hlNetCost,
        avgFeeRateBps: hlNotional > 0 ? (hlFees / hlNotional) * 10000 : 0,
        topCoins,
      },
      gains: {
        events: usdcLogs.length,
        feesUsdc: gainsFeesUsdc,
        positionSizeUsdc: gainsSizeUsdc,
        avgFeeRateBps:
          gainsSizeUsdc > 0 ? (gainsFeesUsdc / gainsSizeUsdc) * 10000 : 0,
      },
      comparison: {
        gainsEquivForHlNotional: gainsEquivForHl,
        hlSavedVsGains: gainsEquivForHl - hlFees,
        hlCheaperMultiple: hlFees > 0 ? gainsEquivForHl / hlFees : null,
        hlEquivForGainsVolume: hlEquivForGains,
        gainsSavedVsHl: gainsFeesUsdc - hlEquivForGains,
      },
    });
  } catch (err) {
    console.error("[fee-compare]", err);
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }
}
