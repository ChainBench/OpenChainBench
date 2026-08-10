export type WindowMetrics = {
  gross: number;
  burn: number;
  lp: number;
  spot: number;
};

export type ProtocolRow = {
  id: string;
  name: string;
  slug: string;
  category: string;
  latestDay: string;
  windows: Record<string, WindowMetrics>;
};

export type LeaderboardResponse = {
  updatedAt: string;
  protocols: ProtocolRow[];
};

const APPS_API = "https://apps.openchainbench.com";

export async function fetchAppsLeaderboard(): Promise<LeaderboardResponse | null> {
  try {
    const res = await fetch(`${APPS_API}/api/leaderboard`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
