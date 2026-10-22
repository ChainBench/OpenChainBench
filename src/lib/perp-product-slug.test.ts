import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { perpProductSlug } from "./perp-product-slug";
import { PERP_VENUES } from "./perp-stats";
import { PERP_VENUE_META } from "./perp-venue-context";

/**
 * One product, one URL. A cohort venue whose slug differs from its product
 * registry slug gets two indexable pages, each self-canonical, if the mapping
 * is missing anywhere.
 *
 * Nova is how this was found: it was already on the site as a Hyperliquid
 * frontend under "nova-markets" (bench 030) when it joined the perp cohort as
 * "nova" (benches 041 and 116). Both answered 200 with their own canonical,
 * one carrying the logo and the frontend bench, the other the perp cards.
 *
 * Three places have to agree for that not to happen, which is why this is a
 * test and not a comment: the slug map, the venue meta's productSlug, and the
 * redirect on the product route.
 */

const PRODUCT_PAGE = readFileSync(
  join(import.meta.dir, "../app/products/[slug]/page.tsx"),
  "utf8",
);

describe("a cohort venue has exactly one product page", () => {
  // Not every entry in the map is an alias. coinbase -> coinbase-international
  // maps the cohort LINK, because the perp row is Coinbase International while
  // /products/coinbase is US retail Coinbase: a different entity that keeps
  // its own page, verified 200 on prod. gmx-v2 and trade-xyz are cohort keys
  // that were never provider slugs, and already 308 (checked on prod).
  //
  // The rule that actually matters is narrower: a cohort slug that is also a
  // provider slug, and therefore generates its own product page, must redirect
  // to the canonical one. Nova is that case, which is how the duplicate was
  // found, so it is named rather than derived.
  const MUST_REDIRECT: Record<string, string> = { nova: "nova-markets" };

  test("a cohort slug that would generate its own page redirects", () => {
    for (const [from, to] of Object.entries(MUST_REDIRECT)) {
      expect(
        PRODUCT_PAGE.includes(`slug === "${from}"`),
        `/products/${from} does not redirect, so it answers 200 beside /products/${to}`,
      ).toBe(true);
      expect(PRODUCT_PAGE).toContain(`permanentRedirect("/products/${to}")`);
      // Both call sites, or the metadata-only redirect leaves a cached 404
      // behind. The file's own comment records that happening (merkle).
      const sites = PRODUCT_PAGE.split(`slug === "${from}"`).length - 1;
      expect(sites, `${from} is redirected in ${sites} place(s), want 2`).toBe(2);
    }
    // And the map has to agree with the redirect target.
    for (const [from, to] of Object.entries(MUST_REDIRECT)) {
      expect(perpProductSlug(from)).toBe(to);
    }
  });

  test("perpProductSlug and PERP_VENUE_META cannot disagree", () => {
    // The hub links through perpProductSlug, the product page resolves
    // through PERP_VENUE_META.productSlug. If they differ, the link and the
    // page that claims the venue point at two different URLs.
    for (const [cohortSlug, meta] of Object.entries(PERP_VENUE_META)) {
      expect(
        meta.productSlug ?? cohortSlug,
        `${cohortSlug}: meta says ${meta.productSlug}, map says ${perpProductSlug(cohortSlug)}`,
      ).toBe(perpProductSlug(cohortSlug));
    }
  });

  test("every cohort venue has a meta entry, so it gets a venue dashboard", () => {
    // A venue in PERP_VENUES but not PERP_VENUE_META renders on the hub and
    // the benches while its product page shows no perp numbers at all. Nova
    // shipped that way for one commit.
    const missing = PERP_VENUES.filter((v) => !PERP_VENUE_META[v.slug]).map(
      (v) => v.slug,
    );
    expect(missing).toEqual([]);
  });

  test("nova specifically resolves to the page that already had its logo", () => {
    expect(perpProductSlug("nova")).toBe("nova-markets");
    expect(PERP_VENUE_META.nova?.productSlug).toBe("nova-markets");
  });
});
