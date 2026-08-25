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

// Static rates per venue (per-action, per-side decimals)
const STATIC_RATES: Record<string, number> = {
  hyperliquid: HL_TAKER_PER_SIDE,
  gains: 0, // filled from live API
  lighter: 0.0,
  dydx: 0.0005,
  "gmx-v2": 0.0005,
  paradex: 0.0005,
  extended: 0.0004,
  aster: 0.0003,
  edgex: 0.0002,
};

const RATE_NOTES: Record<string, string> = {
  hyperliquid: "3.5 bps taker (per action)",
  gains: "Live taker rate (per-coin, per action)",
  lighter: "0 bps (fee-free)",
  dydx: "5 bps taker (tier-0)",
  "gmx-v2": "5 bps conservative",
  paradex: "5 bps taker",
  extended: "4 bps taker",
  aster: "3 bps taker",
  edgex: "2 bps taker",
};

const VENUE_NAMES: Record<string, string> = {
  hyperliquid: "Hyperliquid",
  gains: "Gains",
  lighter: "Lighter",
  dydx: "dYdX v4",
  "gmx-v2": "GMX v2",
  paradex: "Paradex",
  extended: "Extended",
  aster: "Aster",
  edgex: "EdgeX",
};

let gainsFeeCache: { coinRoundTrip: Record<string, number>; perSide: Record<string, number>; avgPerSide: number; ts: number } | null = null;
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

type HlWalletData = {
  fills: number;
  notionalUsd: number;
  feesUsd: number;
  fundingUsd: number;
  netCostUsd: number;
  avgFeeRateBps: number;
  topCoins: Array<{
    coin: string;
    fills: number;
    notional: number;
    fees: number;
  }>;
  recentFills: Array<{
    time: number;
    coin: string;
    dir: string;
    side: string;
    notional: number;
    hlFee: number;
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

type VenueResult = {
  slug: string;
  name: string;
  ratePerAction: number;
  rateBps: number;
  rateNote: string;
  wallet: HlWalletData | GainsWalletData | null;
};

type ComparisonResult = {
  aToBSim: {
    aNotionalWithBRate: number;
    aFeesActual: number;
    bEquivFees: number;
    saved: number;
    multiple: number | null;
  } | null;
  bToASim: {
    bNotionalWithARate: number;
    bFeesActual: number;
    aEquivFees: number;
    saved: number;
    multiple: number | null;
  } | null;
};

async function fetchGainsFeeRates(): Promise<{ coinRoundTrip: Record<string, number>; perSide: Record<string, number>; avgPerSide: number }> {
  const now = Date.now();
  if (gainsFeeCache && now - gainsFeeCache.ts < GAINS_CACHE_TTL_MS) {
    return { coinRoundTrip: gainsFeeCache.coinRoundTrip, perSide: gainsFeeCache.perSide, avgPerSide: gainsFeeCache.avgPerSide };
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
  const avgPerSide = sides.length > 0 ? sides.reduce((a, b) => a + b, 0) / sides.length : 0.0005;
  gainsFeeCache = { coinRoundTrip, perSide, avgPerSide, ts: now };
  return { coinRoundTrip, perSide, avgPerSide };
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

function buildHlWalletData(
  recentFills: HlFill[],
  hlFundingTotal: number,
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

export async function GET(req: Request) {
  const rl = rateLimit(clientKey(req, "fee-compare"), 5, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet")?.trim() ?? "";
  const days = Math.min(180, Math.max(7, parseInt(url.searchParams.get("days") ?? "90", 10)));
  const venueA = (url.searchParams.get("venueA") ?? "hyperliquid").toLowerCase();
  const venueB = (url.searchParams.get("venueB") ?? "gains").toLowerCase();

  const validSlugs = Object.keys(STATIC_RATES);
  if (!validSlugs.includes(venueA) || !validSlugs.includes(venueB)) {
    return NextResponse.json({ error: "invalid_venue" }, { status: 400 });
  }
  if (venueA === venueB) {
    return NextResponse.json({ error: "same_venue" }, { status: 400 });
  }

  const walletProvided = WALLET_RE.test(wallet);
  const needsWallet = (venueA === "hyperliquid" || venueA === "gains" || venueB === "hyperliquid" || venueB === "gains");
  const fetchWallet = walletProvided && needsWallet;

  if (walletProvided === false && needsWallet === false) {
    // Neither venue supports wallet data — just return rate cards
  } else if (walletProvided && !WALLET_RE.test(wallet)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }

  const cutoffMs = Date.now() - days * 86400 * 1000;

  try {
    const gainsData = await fetchGainsFeeRates();

    // Resolve per-action rate for each venue
    function resolveRate(slug: string): number {
      if (slug === "gains") return gainsData.avgPerSide;
      return STATIC_RATES[slug] ?? 0.0005;
    }

    const rateA = resolveRate(venueA);
    const rateB = resolveRate(venueB);

    let hlFillsData: HlFill[] = [];
    let hlFundingData: HlFundingEvent[] = [];
    let gainsLogsData: Array<{ collateralIndex: number; orderType: number; posSize: bigint; totalFees: bigint }> = [];

    if (fetchWallet) {
      const needsHl = venueA === "hyperliquid" || venueB === "hyperliquid";
      const needsGains = venueA === "gains" || venueB === "gains";

      const fetches: Promise<void>[] = [];

      if (needsHl) {
        fetches.push(
          fetchHlFills(wallet).then((f) => { hlFillsData = f; }),
          fetchHlFunding(wallet, cutoffMs).then((f) => { hlFundingData = f; }),
        );
      }

      if (needsGains) {
        fetches.push(
          getLatestBlock().then(async (latestBlock) => {
            const fromBlock = Math.max(0, latestBlock - Math.ceil(days * BLOCKS_PER_DAY));
            gainsLogsData = await fetchGainsLogs(wallet, fromBlock, latestBlock);
          }),
        );
      }

      await Promise.all(fetches);
    }

    // Build venue results
    function buildVenueResult(slug: string, rate: number): VenueResult {
      let walletData: HlWalletData | GainsWalletData | null = null;

      if (fetchWallet && slug === "hyperliquid") {
        const recentFills = hlFillsData.filter((f) => f.time >= cutoffMs);
        const recentFunding = hlFundingData.filter((f) => f.time >= cutoffMs);
        const fundingTotal = recentFunding.reduce((s, f) => s + parseFloat(f.delta?.usdc ?? "0"), 0);
        walletData = buildHlWalletData(recentFills, fundingTotal);
      } else if (fetchWallet && slug === "gains") {
        const usdcLogs = gainsLogsData.filter((l) => l.collateralIndex === 3);
        const feesUsdc = usdcLogs.reduce((s, l) => s + Number(l.totalFees) / 1e6, 0);
        const sizeUsdc = usdcLogs.reduce((s, l) => s + Number(l.posSize) / 1e6, 0);
        walletData = {
          events: usdcLogs.length,
          feesUsdc,
          positionSizeUsdc: sizeUsdc,
          avgFeeRateBps: sizeUsdc > 0 ? (feesUsdc / sizeUsdc) * 10000 : 0,
        } satisfies GainsWalletData;
      }

      return {
        slug,
        name: VENUE_NAMES[slug] ?? slug,
        ratePerAction: rate,
        rateBps: rate * 10000,
        rateNote: RATE_NOTES[slug] ?? "Hardcoded rate",
        wallet: walletData,
      };
    }

    const venueAResult = buildVenueResult(venueA, rateA);
    const venueBResult = buildVenueResult(venueB, rateB);

    // Build comparison
    const comparison: ComparisonResult = { aToBSim: null, bToASim: null };

    // aToBSim: use venueA wallet fills to simulate venueB cost
    if (venueAResult.wallet !== null) {
      if (venueA === "hyperliquid") {
        const hlW = venueAResult.wallet as HlWalletData;
        if (hlW.fills > 0) {
          // For Gains as venueB, use per-coin rates where available; else use avgPerSide
          let bEquiv = 0;
          let aNotionalUsed = 0;
          let aFeesActual = 0;

          if (venueB === "gains") {
            for (const fill of hlFillsData.filter((f) => f.time >= cutoffMs)) {
              const notional = parseFloat(fill.px) * parseFloat(fill.sz);
              const fee = parseFloat(fill.fee);
              const coinRate = gainsData.perSide[fill.coin];
              const effectiveRate = coinRate ?? gainsData.avgPerSide;
              bEquiv += notional * effectiveRate;
              aNotionalUsed += notional;
              aFeesActual += fee;
            }
          } else {
            aNotionalUsed = hlW.notionalUsd;
            aFeesActual = hlW.feesUsd;
            bEquiv = hlW.notionalUsd * rateB;
          }

          const saved = bEquiv - aFeesActual;
          comparison.aToBSim = {
            aNotionalWithBRate: aNotionalUsed,
            aFeesActual,
            bEquivFees: bEquiv,
            saved,
            multiple: aFeesActual > 0 ? bEquiv / aFeesActual : null,
          };
        }
      } else if (venueA === "gains") {
        const gainsW = venueAResult.wallet as GainsWalletData;
        if (gainsW.events > 0) {
          // Each FeesProcessed event = one action, positionSizeUsdc = notional
          const bEquiv = gainsW.positionSizeUsdc * rateB;
          const saved = bEquiv - gainsW.feesUsdc;
          comparison.aToBSim = {
            aNotionalWithBRate: gainsW.positionSizeUsdc,
            aFeesActual: gainsW.feesUsdc,
            bEquivFees: bEquiv,
            saved,
            multiple: gainsW.feesUsdc > 0 ? bEquiv / gainsW.feesUsdc : null,
          };
        }
      }
    }

    // bToASim: use venueB wallet fills to simulate venueA cost
    if (venueBResult.wallet !== null) {
      if (venueB === "hyperliquid") {
        const hlW = venueBResult.wallet as HlWalletData;
        if (hlW.fills > 0) {
          let aEquiv = 0;
          let bNotionalUsed = 0;
          let bFeesActual = 0;

          if (venueA === "gains") {
            for (const fill of hlFillsData.filter((f) => f.time >= cutoffMs)) {
              const notional = parseFloat(fill.px) * parseFloat(fill.sz);
              const fee = parseFloat(fill.fee);
              const coinRate = gainsData.perSide[fill.coin];
              const effectiveRate = coinRate ?? gainsData.avgPerSide;
              aEquiv += notional * effectiveRate;
              bNotionalUsed += notional;
              bFeesActual += fee;
            }
          } else {
            bNotionalUsed = hlW.notionalUsd;
            bFeesActual = hlW.feesUsd;
            aEquiv = hlW.notionalUsd * rateA;
          }

          const saved = bFeesActual - aEquiv;
          comparison.bToASim = {
            bNotionalWithARate: bNotionalUsed,
            bFeesActual,
            aEquivFees: aEquiv,
            saved,
            multiple: bFeesActual > 0 ? aEquiv / bFeesActual : null,
          };
        }
      } else if (venueB === "gains") {
        const gainsW = venueBResult.wallet as GainsWalletData;
        if (gainsW.events > 0) {
          const aEquiv = gainsW.positionSizeUsdc * rateA;
          const saved = gainsW.feesUsdc - aEquiv;
          comparison.bToASim = {
            bNotionalWithARate: gainsW.positionSizeUsdc,
            bFeesActual: gainsW.feesUsdc,
            aEquivFees: aEquiv,
            saved,
            multiple: gainsW.feesUsdc > 0 ? aEquiv / gainsW.feesUsdc : null,
          };
        }
      }
    }

    return NextResponse.json({
      wallet: walletProvided ? wallet.toLowerCase() : null,
      days,
      generatedAt: Date.now(),
      venueA: venueAResult,
      venueB: venueBResult,
      comparison,
    });
  } catch (err) {
    console.error("[fee-compare]", err);
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }
}
