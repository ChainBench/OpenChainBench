export type NativeRevenue = {
  symbol: string;
  amount: number;
  usd: number | null;
};

export type EVMChainRevenue = {
  stable24h: number;
  stable7d: number;
  stable30d: number;
  native: NativeRevenue | null; // 24h only
  coverage: "full" | "stable-only";
};

export type EVMPlatformRow = {
  platform: string;
  chains: Record<string, EVMChainRevenue>;
};

export type EVMRevenueResponse = {
  updatedAt: string;
  platforms: EVMPlatformRow[];
};

const EXEC_API = "https://exec.openchainbench.com";

export async function fetchEVMRevenue(): Promise<EVMRevenueResponse | null> {
  try {
    const res = await fetch(`${EXEC_API}/api/evm-revenue`, {
      next: { revalidate: 60 },
    });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

/** Total 24h USD for a platform across all chains. */
export function totalRevenue24h(row: EVMPlatformRow): number {
  let total = 0;
  for (const chain of Object.values(row.chains)) {
    total += chain.stable24h;
    if (chain.native?.usd != null) total += chain.native.usd;
  }
  return total;
}

export function fmtUSD(n: number): string {
  if (n === 0) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export const CHAIN_LABELS: Record<string, string> = {
  ethereum: "Ethereum",
  bsc: "BSC",
  base: "Base",
};

export const EVM_CHAINS = ["ethereum", "bsc", "base"] as const;
