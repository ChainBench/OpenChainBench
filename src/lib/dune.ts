// Dune query 8306192: FOMO relay fees — MAX(platform_fees) per fee_period (rows are cumulative snapshots)
// Old query 8304081 summed all cumulative rows → ~8-16x inflation. Fixed by deduping with MAX.
const FOMO_QUERY_ID = 8306192;

export type FOMORelayFees = {
  fees24h: number;
  fees7d: number;
  fees30d: number;
  latestDate: string;
};

export async function fetchFOMORelayFees(): Promise<FOMORelayFees | null> {
  const apiKey = process.env.DUNE_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `https://api.dune.com/api/v1/query/${FOMO_QUERY_ID}/results`,
      {
        headers: { "X-Dune-API-Key": apiKey },
        next: { revalidate: 3600 },
      }
    );
    if (!res.ok) return null;

    const json = await res.json();
    const row = json?.result?.rows?.[0];
    if (!row) return null;

    return {
      fees24h: row.fees_24h ?? 0,
      fees7d: row.fees_7d ?? 0,
      fees30d: row.fees_30d ?? 0,
      latestDate: row.latest_date ?? "",
    };
  } catch {
    return null;
  }
}
