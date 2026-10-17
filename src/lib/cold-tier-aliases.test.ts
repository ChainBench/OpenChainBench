import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { hasLogo, logoPath } from "@/lib/logo-manifest";
import { canonicalize } from "@/lib/providers";

/**
 * The cold-start tier is a second measurement arm on the same endpoints, so
 * every `<vendor>-cold` row needs two aliases to behave like its vendor: one in
 * logo-manifest (or the row renders initials instead of a mark) and one in
 * providers.ts (or the slug builds its own product page, an indexable duplicate
 * of the vendor with no description and no official link).
 *
 * Nothing strips the suffix, both tables are explicit, and adding a vendor to
 * the tier without them is silent. That is how `/products/dwellir-cold` reached
 * production as a 200 carrying the same title as `/products/dwellir` plus a
 * sitemap entry, two weeks after the original four were folded correctly.
 *
 * So the fixture is the spec directory itself: this reads whatever cold rows
 * exist today and fails on the next one added without its aliases.
 */

const SPEC_DIR = join(import.meta.dir, "..", "..", "benchmarks");

type SpecProvider = { slug?: string; tier?: string };

/** Every `tier: keyed-cold` slug declared anywhere in the spec directory. */
function coldSlugs(): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(SPEC_DIR)) {
    if (!file.endsWith("-rpc.yml")) continue;
    const spec = yaml.load(readFileSync(join(SPEC_DIR, file), "utf8")) as {
      providers?: SpecProvider[];
    };
    for (const p of spec?.providers ?? []) {
      if (p?.tier === "keyed-cold" && p.slug) found.add(p.slug);
    }
  }
  return [...found].sort();
}

describe("cold-start tier aliases", () => {
  const slugs = coldSlugs();

  // A guard that silently guards nothing is worse than no guard: if the tier
  // is ever renamed, this test would pass on an empty list.
  test("the spec directory declares a cold tier at all", () => {
    expect(slugs.length).toBeGreaterThanOrEqual(5);
    for (const slug of slugs) expect(slug.endsWith("-cold")).toBe(true);
  });

  test("every cold slug resolves to its vendor's product page", () => {
    const wrong = slugs.filter((slug) => canonicalize(slug).slug !== slug.replace(/-cold$/, ""));
    expect(wrong).toEqual([]);
  });

  test("every cold slug renders its vendor's logo, not initials", () => {
    const missing = slugs.filter((slug) => !hasLogo(slug));
    expect(missing).toEqual([]);
  });

  test("the cold logo is the same file as the vendor's", () => {
    const mismatched = slugs.filter(
      (slug) => logoPath(slug) !== logoPath(slug.replace(/-cold$/, "")),
    );
    expect(mismatched).toEqual([]);
  });

  // The cold arm is ranked against the keyed arm's vendors, so a vendor
  // measured warm but not cold is a hole in the comparison rather than a
  // crash. Reported per chain, because that is how it gets fixed.
  test("every keyed vendor on a chain also has a cold row there", () => {
    const holes: string[] = [];
    for (const file of readdirSync(SPEC_DIR)) {
      if (!file.endsWith("-rpc.yml")) continue;
      const spec = yaml.load(readFileSync(join(SPEC_DIR, file), "utf8")) as {
        providers?: SpecProvider[];
      };
      const providers = spec?.providers ?? [];
      const keyed = providers.filter((p) => p?.tier === "keyed").map((p) => p.slug);
      const cold = new Set(
        providers
          .filter((p) => p?.tier === "keyed-cold")
          .map((p) => p.slug?.replace(/-cold$/, "")),
      );
      for (const slug of keyed) {
        if (slug && !cold.has(slug)) holes.push(`${file}: ${slug}`);
      }
    }
    expect(holes).toEqual([]);
  });
});
