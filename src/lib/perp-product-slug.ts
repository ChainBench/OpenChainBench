/**
 * Cohort slug to /products/<slug>. Pure map, safe in client components:
 * the cohort keys a few venues differently from the product registry
 * (gmx-v2 is /products/gmx, trade-xyz is /products/xyz) and the Coinbase
 * perp row is Coinbase International, a different entity and product
 * line from the US retail Coinbase page. Every venue-to-product link on
 * the site goes through `perpProductSlug`; PERP_VENUE_META reads the
 * same map for its productSlug field.
 */
export const PERP_PRODUCT_SLUGS: Readonly<Record<string, string>> = {
  "gmx-v2": "gmx",
  "trade-xyz": "xyz",
  coinbase: "coinbase-international",
};

export function perpProductSlug(cohortSlug: string): string {
  return PERP_PRODUCT_SLUGS[cohortSlug] ?? cohortSlug;
}
