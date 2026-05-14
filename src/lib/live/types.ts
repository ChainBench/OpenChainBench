/**
 * Wire types for the openchainbench live relay. Mirrors the JSON shapes
 * produced by `miniapps/ocb-stream-relay` (Go) — keep both sides in sync
 * when adding or renaming fields.
 */

export type SwapEvent = {
  type: "swap";
  chain: string;
  pool: string;
  pair: string;
  exchange: string;
  side: "buy" | "sell";
  usd: number;
  hash: string;
  onChainMs: number;
  mobulaMs: number;
  receivedMs: number;
};

export type ChainBreakdown = {
  name: string;
  vol24h: number;
  trades24h: number;
};

export type GlobalView = {
  vol24h: number;
  trades24h: number;
  buys24h: number;
  sells24h: number;
  fees24h: number;
  mcap: number;
  byChain: ChainBreakdown[];
  lighthouseAt: number;
  mcapAt: number;
};

export type StatsTick = {
  type: "stats";
  global: GlobalView;
  live: { swaps: number; vol: number; chains: number };
  nowMs: number;
};

export type SnapshotMsg = {
  type: "snapshot";
  buckets: Bucket[];
  nowMs: number;
};

export type RelayMessage = SwapEvent | StatsTick | SnapshotMsg;

/** Bucket of incremental per-chain volume over a fixed time window. */
export type Bucket = {
  ts: number;
  perChain: Record<string, number>;
};

/** Ephemeral floating "+$X" label spawned at a line tip on each swap. */
export type ChartPop = {
  id: number;
  chainKey: string;
  pair: string;
  exchange: string;
  usd: number;
  side: "buy" | "sell";
  anchorX: number; // 0–100% of chart width
  anchorY: number; // 0–100% of chart height
};
