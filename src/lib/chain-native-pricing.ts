import { CHAIN_BY_SLUG, type ChainEntry } from "@/lib/chains";

export function nativePricingSymbol(chain: ChainEntry): string | null {
  return chain.nativePriceSymbol === undefined
    ? chain.nativeSymbol ?? null
    : chain.nativePriceSymbol;
}

/** Apply after reading the cache: old snapshots can contain a different asset. */
export function withNativePricePolicy<
  T extends { slug: string; nativePrice: number | null; nativeMcap: number | null },
>(kpis: T): Omit<T, "nativePrice" | "nativeMcap"> & {
  nativePrice: number | null;
  nativeMcap: number | null;
} {
  const chain = CHAIN_BY_SLUG.get(kpis.slug);
  if (!chain || nativePricingSymbol(chain) !== null) return kpis;
  return { ...kpis, nativePrice: null, nativeMcap: null };
}
