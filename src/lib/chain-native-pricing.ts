import { CHAIN_BY_SLUG, type ChainEntry } from "@/lib/chains";

export function nativePricingSymbol(chain: ChainEntry): string | null {
  return chain.nativePriceSymbol === undefined
    ? chain.nativeSymbol ?? null
    : chain.nativePriceSymbol;
}

/** The Mobula /market/data query for a chain's native: by asset id when the
 * registry pins one, else by ticker; null when the asset is not identified. */
export function nativePriceQuery(chain: ChainEntry): string | null {
  if (chain.nativePriceAssetId !== undefined) return `id=${chain.nativePriceAssetId}`;
  const symbol = nativePricingSymbol(chain);
  return symbol === null ? null : `symbol=${encodeURIComponent(symbol)}`;
}

export function mobulaMarketDataUrl(query: string): string {
  return `https://api.mobula.io/api/1/market/data?${query}`;
}

/** Pinned assets must not read a legacy ticker-only metric series. */
export function nativePriceMetricSelector(slug: string, chain = CHAIN_BY_SLUG.get(slug)): string {
  const asset = chain?.nativePriceAssetId;
  return `{chain=${JSON.stringify(slug)}${asset === undefined ? "" : `,asset_id="${asset}"`}}`;
}

/** Apply after reading the cache: old snapshots can contain a different asset. */
export function withNativePricePolicy<
  T extends { slug: string; nativePrice: number | null; nativeMcap: number | null; nativePriceAssetId?: number },
>(kpis: T, chain = CHAIN_BY_SLUG.get(kpis.slug)): Omit<T, "nativePrice" | "nativeMcap"> & {
  nativePrice: number | null;
  nativeMcap: number | null;
} {
  if (!chain) return kpis;
  const identified = nativePriceQuery(chain) !== null;
  const matches = chain.nativePriceAssetId === undefined
    || kpis.nativePriceAssetId === chain.nativePriceAssetId;
  if (identified && matches) return kpis;
  return { ...kpis, nativePrice: null, nativeMcap: null };
}
