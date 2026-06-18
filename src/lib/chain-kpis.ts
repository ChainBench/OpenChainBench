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

import { Prometheus } from "@/lib/prometheus";

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
  /** Mobula's tokens-indexed-on-chain count (proxy for Mobula coverage). */
  mobulaTokensIndexed: number | null;
};

function promUrl(): string | null {
  return process.env.PROMETHEUS_URL?.trim() || null;
}

/**
 * Fetch the 6 chain KPI gauges in one Promise.all. Each is independent;
 * a failure on one query doesn't drop the others (graceful per-card
 * rendering on the page).
 *
 * Returns null when Prom isn't configured at all (preview / dev without
 * the env var) so the caller can render an explicit "Live KPIs require
 * Prom" banner instead of a strip full of em-dashes.
 */
export async function fetchChainKpis(slug: string): Promise<ChainKpis | null> {
  const url = promUrl();
  if (!url) return null;
  let prom: Prometheus;
  try {
    prom = new Prometheus(url);
  } catch {
    return null;
  }

  const sel = `{chain="${slug}"}`;
  const [tvl, dexVolume24h, stablesMcap, nativePrice, nativeMcap, mobulaTokensIndexed] =
    await Promise.all([
      prom.scalar(`chain_tvl_usd${sel}`),
      prom.scalar(`chain_dex_volume_24h_usd${sel}`),
      prom.scalar(`chain_stables_mcap_usd${sel}`),
      prom.scalar(`chain_native_price_usd${sel}`),
      prom.scalar(`chain_native_mcap_usd${sel}`),
      prom.scalar(`chain_mobula_tokens_indexed${sel}`),
    ]);

  return {
    slug,
    tvl,
    dexVolume24h,
    stablesMcap,
    nativePrice,
    nativeMcap,
    mobulaTokensIndexed,
  };
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
    k.nativeMcap != null ||
    k.mobulaTokensIndexed != null
  );
}
