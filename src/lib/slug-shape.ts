/**
 * Shape tests on provider slugs that both server and client code need.
 * Kept free of imports: `src/lib/providers.ts` pulls the materialize
 * store (ioredis) behind it, so a client component that only needs to
 * recognise a hex builder address must not import from there (the 'dns'
 * resolution error in the browser bundle, 2026-09-23).
 */

/** Anonymous Hyperliquid builder addresses used as row slugs. */
const HEX_ADDRESS_SLUG = /^0x[a-f0-9]+$/;

export function isHexAddressSlug(slug: string): boolean {
  return HEX_ADDRESS_SLUG.test(slug.toLowerCase());
}
