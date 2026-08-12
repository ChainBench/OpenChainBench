export type ExecWindowStats = {
  txCount: number;
  avgPriorityFeeLamports: number;
  p50CUPriceMicro: number;
  p95CUPriceMicro: number;
  avgPlatformFeeLamports: number;
  sumPlatformFeeLamports: number;
  jitoRate: number;
  avgCUConsumed: number;
};

export type ExecPlatformRow = {
  platform: string;
  latestBucket: string;
  windows: Record<string, ExecWindowStats>;
};

export type ExecLeaderboardResponse = {
  updatedAt: string;
  platforms: ExecPlatformRow[];
};

const EXEC_API = "https://exec.openchainbench.com";

export async function fetchExecLeaderboard(): Promise<ExecLeaderboardResponse | null> {
  try {
    const res = await fetch(`${EXEC_API}/api/exec-leaderboard`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// Human-readable platform display name.
export const PLATFORM_DISPLAY: Record<string, string> = {
  "pump.fun": "pump.fun",
  "fomo": "FOMO",
  "axiom": "Axiom",
  "gmgn": "GMGN",
};

// Converts lamports to SOL (string with 5 decimals).
export function lamportsToSOL(l: number): string {
  return (l / 1e9).toFixed(5);
}

// Converts microlamports/CU to a human-readable string.
export function fmtCUPrice(micro: number): string {
  if (micro === 0) return "—";
  if (micro >= 1000) return `${(micro / 1000).toFixed(1)}k μL/CU`;
  return `${Math.round(micro)} μL/CU`;
}
