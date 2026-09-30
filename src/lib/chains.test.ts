import { describe, expect, test } from "bun:test";
import { CHAINS, CHAIN_BY_SLUG } from "@/lib/chains";

/**
 * The chain registry is iterated directly in places that cannot tolerate a
 * repeat: `generateStaticParams` in src/app/chains/[slug]/page.tsx prerenders
 * one route per entry, src/app/chains/page.tsx renders one card per entry, and
 * src/lib/sitemap-builder.ts emits one <loc> per entry. CHAIN_BY_SLUG hides a
 * duplicate because the last entry wins the Map, so nothing throws and only
 * the rendered output shows it.
 *
 * It happened: two `cosmos-hub` entries, differing only in `description`,
 * shipped a duplicate row on /chains and a 1,211-entry sitemap with 1,210
 * unique URLs. Found by an SEO audit rather than by anything in CI, hence
 * this test.
 */
describe("CHAINS registry", () => {
  test("every slug is unique", () => {
    const seen = new Map<string, number>();
    for (const c of CHAINS) seen.set(c.slug, (seen.get(c.slug) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([slug, n]) => `${slug} x${n}`);
    expect(dupes).toEqual([]);
  });

  test("CHAIN_BY_SLUG loses no entry, so the Map and the array agree on size", () => {
    expect(CHAIN_BY_SLUG.size).toBe(CHAINS.length);
  });

  test("every entry carries the fields the chain hub and the sitemap read", () => {
    for (const c of CHAINS) {
      expect(c.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(c.label.length).toBeGreaterThan(0);
      expect(["L1", "L2", "L3"]).toContain(c.category);
    }
  });
});
