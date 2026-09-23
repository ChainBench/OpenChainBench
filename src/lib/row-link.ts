import { CHAIN_BY_SLUG } from "@/lib/chain-catalog";
import { canonicalChainSlug } from "@/lib/chain-aliases";
import { isRegion } from "@/lib/brand";
import { isHexAddressSlug } from "@/lib/slug-shape";
import type { Benchmark, ProviderResult } from "@/types/benchmark";

/**
 * Where a ledger row points.
 *
 * Every bench linked its rows to `/products/<slug>`, which is right when
 * the row is a provider and wrong when it is a chain. On the Blockchains
 * benches that produced, measured on 41 rows of bench 273:
 *
 *   3 rows 404      (/products/cyber, /products/manta, /products/morph)
 *   10 rows 308     to the /chains page, via a hand-kept list in next.config
 *   27 rows 200     with a canonical pointing at /chains/<slug> anyway
 *   1 row  200      to a different subject entirely (/products/hyperliquid
 *                   is the perp venue, not the chain)
 *
 * So a page in the sitemap at priority 0.95 spent its entire outbound link
 * budget on 404s, redirect hops and self-declared duplicates. The same
 * template is live on production for l1-finality, l2-block-time and
 * network-fees, where 38 of 41 links are redirects.
 *
 * A chain row links to the chain hub, which is the canonical document for
 * it and returns 200 directly. Everything else is unchanged.
 *
 * Returns null when the row should render as plain text: a region, a raw
 * address, or a chain the registry does not know.
 */
export function rowHref(
  benchmark: Pick<Benchmark, "category">,
  r: Pick<ProviderResult, "slug">,
): string | null {
  if (isRegion(r.slug) || isHexAddressSlug(r.slug)) return null;
  if (benchmark.category === "Blockchains") {
    const canon = canonicalChainSlug(r.slug);
    return CHAIN_BY_SLUG.has(canon) ? `/chains/${canon}` : null;
  }
  return `/products/${r.slug}`;
}
