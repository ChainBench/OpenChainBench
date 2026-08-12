// DeFiLlama fees API — slugs verified against api.llama.fi/summary/fees/{slug} (2026-08)

type DLBreakdown = Record<string, Record<string, number>>;

type DLSummary = {
  total24h: number | null;
  total7d: number | null;
  total30d: number | null;
  change_1d: number | null;
  breakdown24h: DLBreakdown | null;
};

// Chains we surface in the leaderboard (normalized to lowercase)
const TRACKED_CHAINS = new Set(["solana", "ethereum", "bsc", "base"]);

export type DLPlatformData = {
  total24h: number;
  total7d: number;
  total30d: number;
  change_1d: number | null;
  // Per-chain 24h fees in USD (keys: solana, ethereum, bsc, base)
  chain24h: Partial<Record<string, number>>;
};

/** @deprecated use DLPlatformData */
export type DLPlatformRevenue = DLPlatformData;

function extractChain24h(breakdown: DLBreakdown | null): Partial<Record<string, number>> {
  if (!breakdown) return {};
  const result: Record<string, number> = {};
  for (const [rawChain, data] of Object.entries(breakdown)) {
    const norm = rawChain.toLowerCase();
    if (!TRACKED_CHAINS.has(norm)) continue;
    const amount = Object.values(data).reduce((s, v) => s + v, 0);
    if (amount > 0) result[norm] = (result[norm] ?? 0) + amount;
  }
  return result;
}

async function fetchDLSummary(slug: string): Promise<DLSummary | null> {
  try {
    const res = await fetch(
      `https://api.llama.fi/summary/fees/${encodeURIComponent(slug)}?dataType=dailyRevenue`,
      { next: { revalidate: 300 } }
    );
    if (!res.ok) return null;
    return res.json() as Promise<DLSummary>;
  } catch {
    return null;
  }
}

export async function fetchDeFiLlamaData(slugMap: Record<string, string>): Promise<Map<string, DLPlatformData>> {
  const entries = Object.entries(slugMap);
  const responses = await Promise.all(entries.map(([, slug]) => fetchDLSummary(slug)));

  const result = new Map<string, DLPlatformData>();
  for (let i = 0; i < entries.length; i++) {
    const [appId] = entries[i];
    const data = responses[i];
    if (!data) continue;
    result.set(appId, {
      total24h: data.total24h ?? 0,
      total7d: data.total7d ?? 0,
      total30d: data.total30d ?? 0,
      change_1d: data.change_1d ?? null,
      chain24h: extractChain24h(data.breakdown24h),
    });
  }
  return result;
}

/** @deprecated use fetchDeFiLlamaData */
export async function fetchDeFiLlamaRevenue(): Promise<Map<string, DLPlatformData>> {
  return new Map();
}
