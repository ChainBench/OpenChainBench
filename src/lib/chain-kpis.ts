/**
 * Server-side helper that reads the per-chain KPI gauges from Prom. The
 * source-of-truth values are published by the `chain-kpis` harness on
 * Railway (mobula-api/miniapps/chain-kpis), pulled from DefiLlama
 * (TVL / DEX 24h / stables) and Mobula (native price+mcap / tokens
 * indexed) on a fixed cadence.
 *
 * Each field is independently nullable: a chain that DefiLlama doesn't
 * track for stables (Stellar, Blast, …) gets a real TVL value but a
 * null stables. The page renders only the cards that have data, so the
 * adaptive grid never shows a fake-zero placeholder.
 *
 * Returns null only when Prom is fully unreachable. A successful Prom
 * query that returns no series for a chain → `{ allNull: true }` is
 * encoded as every field null (the page hides the strip entirely).
 */

import { unstable_cache } from "next/cache";
import { Prometheus } from "@/lib/prometheus";
import {
  readCohortSnapshot,
  writeCohortSnapshot,
} from "@/lib/cohort-snapshot";

export type ChainKpis = {
  slug: string;
  /** DefiLlama TVL across all DeFi protocols (lending, dex, staking, …). */
  tvl: number | null;
  /** DefiLlama aggregate 24h DEX volume across every tracked DEX. */
  dexVolume24h: number | null;
  /** DefiLlama USD-pegged stablecoin circulating mcap on this chain. */
  stablesMcap: number | null;
  /** Mobula native token spot price in USD. */
  nativePrice: number | null;
  /** Mobula native token circulating market cap in USD. */
  nativeMcap: number | null;
};

/** TVL daily samples for the sparkline chart. Last 30 days, oldest first. */
export type ChainTvlHistory = {
  slug: string;
  points: { date: number; tvl: number }[];
};

function promUrl(): string | null {
  return process.env.PROMETHEUS_URL?.trim() || null;
}

/** Upstash key prefix for the per-chain KPI blobs, written by the
 *  materialize worker on every tierA sweep. One blob per chain slug keeps
 *  the payload tiny and makes a stale entry on one chain independent from
 *  the others. The cohort-snapshot module appends its own `:v1`. */
const CHAIN_KPIS_KEY_PREFIX = "chain-kpis:";

/**
 * Fetch the 6 chain KPI gauges in one Promise.all. Each is independent;
 * a failure on one query doesn't drop the others (graceful per-card
 * rendering on the page).
 *
 * Returns null when Prom isn't configured at all (preview / dev without
 * the env var) so the caller can render an explicit "Live KPIs require
 * Prom" banner instead of a strip full of em-dashes.
 *
 * Exported so the materialize worker can call the uncached Prom path
 * directly before parking the result in Upstash; the public reader
 * (fetchChainKpis) goes through the snapshot layer + unstable_cache below.
 */
export async function fetchChainKpisFresh(
  slug: string,
): Promise<ChainKpis | null> {
  const url = promUrl();
  if (!url) return null;
  let prom: Prometheus;
  try {
    prom = new Prometheus(url);
  } catch {
    return null;
  }

  const sel = `{chain="${slug}"}`;
  const [tvl, dexVolume24h, stablesMcap, nativePrice, nativeMcap] =
    await Promise.all([
      prom.scalar(`chain_tvl_usd${sel}`),
      prom.scalar(`chain_dex_volume_24h_usd${sel}`),
      prom.scalar(`chain_stables_mcap_usd${sel}`),
      prom.scalar(`chain_native_price_usd${sel}`),
      prom.scalar(`chain_native_mcap_usd${sel}`),
    ]);

  return {
    slug,
    tvl,
    dexVolume24h,
    stablesMcap,
    nativePrice,
    nativeMcap,
  };
}

/**
 * Snapshot-first reader for a single chain's KPI blob. Same protocol as
 * the hub cohorts: Upstash blob → live Prom + writeback → null. The
 * worker keeps the blob fresh every 60 s so the typical render never
 * touches Prom; on Vercel prod, Prom isn't even configured, so the
 * writeback branch never runs there and null just falls through.
 */
async function fetchChainKpisRaw(slug: string): Promise<ChainKpis | null> {
  const snapshot = await readCohortSnapshot<ChainKpis>(
    CHAIN_KPIS_KEY_PREFIX + slug,
  );
  if (snapshot) return snapshot.data;
  const fresh = await fetchChainKpisFresh(slug);
  if (fresh) {
    try {
      await writeCohortSnapshot(CHAIN_KPIS_KEY_PREFIX + slug, fresh);
    } catch (err) {
      console.warn(
        `chain-kpis writeback failed for ${slug}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return fresh;
}

const fetchChainKpisCached = unstable_cache(
  fetchChainKpisRaw,
  ["chain-kpis-v1"],
  { revalidate: 60, tags: ["chain-kpis"] },
);

export async function fetchChainKpis(slug: string): Promise<ChainKpis | null> {
  return fetchChainKpisCached(slug);
}

/**
 * Convenience used by `<ChainKpiStrip>` to short-circuit when every
 * field is null — the strip hides entirely rather than rendering an
 * empty card row.
 */
export function hasAnyKpi(k: ChainKpis | null): boolean {
  if (!k) return false;
  return (
    k.tvl != null ||
    k.dexVolume24h != null ||
    k.stablesMcap != null ||
    k.nativePrice != null ||
    k.nativeMcap != null
  );
}

/**
 * DefiLlama chain-name mapping. Mirrors the harness `Registry` in
 * `mobula-monorepo/miniapps/chain-kpis/cmd/script/registry.go`. Kept
 * inline here (rather than imported from a shared package) because the
 * site has no Go interop and the list is small + rarely-changing. Out of
 * sync = the TVL chart hides for that chain (graceful), so a stale entry
 * here can never poison user data. Empty = chain not tracked by DefiLlama.
 */
const DEFILLAMA_CHAIN_NAME: Record<string, string> = {
  ethereum: "Ethereum",
  solana: "Solana",
  bnb: "BSC",
  avalanche: "Avalanche",
  sui: "Sui",
  gram: "TON", // DefiLlama API still uses "TON" as the chain name (verified live)
  stellar: "Stellar",
  tron: "Tron",
  cardano: "Cardano",
  litecoin: "Litecoin",
  monero: "",
  polygon: "Polygon",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  base: "Base",
  zksync: "ZKsync Era",
  linea: "Linea",
  scroll: "Scroll",
  blast: "Blast",
  mantle: "Mantle",
  taiko: "Taiko",
};

/**
 * Fetch the FULL TVL history from DefiLlama. Returns daily samples going
 * back to chain genesis (or as far as DefiLlama has indexed). Used by
 * the interactive chart on /chains/[slug], which lets the user toggle
 * ranges client-side without re-fetching.
 *
 * The JSON is ~50 KB even for old chains (Ethereum 5+ years), revalidate
 * every 15 min mirrors the harness cadence. Network failure / unsupported
 * chain / empty body → null, chart is hidden gracefully.
 */
export async function fetchChainTvlFullHistory(
  slug: string,
): Promise<ChainTvlHistory | null> {
  const dllamaName = DEFILLAMA_CHAIN_NAME[slug];
  if (!dllamaName) return null;
  try {
    const res = await fetch(
      `https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(dllamaName)}`,
      {
        next: { revalidate: 900 },
        headers: { "user-agent": "OCB-site/1.0" },
      },
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as { date: number; tvl: number }[];
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return { slug, points: arr };
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn(`fetchChainTvlFullHistory ${slug} failed:`, err);
    }
    return null;
  }
}

/**
 * Legacy 30-day helper used by other call sites. Thin wrapper that
 * slices the full history. Kept for backward compat.
 */
export async function fetchChainTvlHistory(
  slug: string,
  days = 30,
): Promise<ChainTvlHistory | null> {
  const full = await fetchChainTvlFullHistory(slug);
  if (!full) return null;
  return { slug: full.slug, points: full.points.slice(-days) };
}
