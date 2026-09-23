import { CHAIN_BY_SLUG, canonicalChainSlug } from "@/lib/chains";
import { isRegion } from "@/lib/brand";
import type { Benchmark, ProviderResult } from "@/types/benchmark";

/**
 * A raw contract address used as a row slug (Hyperliquid frontends not yet
 * in builders.json). Duplicated from providers.ts rather than imported:
 * this module is reached from a client component, and providers.ts pulls
 * spec.ts -> materialize/store.ts -> ioredis into the browser bundle. The
 * build fails on it; typecheck and the unit tests do not, which is how it
 * shipped.
 */
const HEX_ADDRESS_SLUG = /^0x[a-f0-9]+$/;

function isHexAddressSlug(slug: string): boolean {
  return HEX_ADDRESS_SLUG.test(slug.toLowerCase());
}

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
