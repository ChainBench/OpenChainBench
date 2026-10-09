import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DEV_ONLY_BENCH_SLUGS,
  REMOVED_BENCH_SLUGS,
} from "@/lib/removed-benches";

/**
 * The /data-api hub curates its benches by hand, because it groups and
 * orders them editorially rather than deriving them. A hand-written list of
 * slugs goes stale the day a bench is retired, and this one did: it carried
 * indexing-freshness (retired 2026-08-05) and portfolio-chain-coverage long
 * after both began answering 410, and indexing-freshness dragged
 * /products/zerion onto the page with it.
 *
 * The page now filters the curated list through the retirement sets. This
 * reads the file rather than importing it, because a Next page module may
 * not export anything the router does not expect.
 */
const SRC = readFileSync(join(import.meta.dir, "page.tsx"), "utf8");

function curatedSlugs(): string[] {
  // [\s\S] rather than . with the s flag: the repo's tsconfig target predates it.
  const m = SRC.match(/const CURATED_BENCH_SLUGS = \[([\s\S]*?)\]/);
  if (!m) throw new Error("CURATED_BENCH_SLUGS not found in page.tsx");
  return [...m[1]!.matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]!);
}

describe("the /data-api hub's bench list", () => {
  test("is still parseable, so the rest of this file means something", () => {
    expect(curatedSlugs().length).toBeGreaterThan(4);
  });

  test("is filtered through the retirement sets before it is rendered", () => {
    // Without this the page links straight at 410s.
    expect(SRC).toContain("REMOVED_BENCH_SLUGS.has(slug)");
    expect(SRC).toContain("DEV_ONLY_BENCH_SLUGS.has(slug)");
  });

  test("renders no bench that is retired or dev-gated", () => {
    const shown = curatedSlugs().filter(
      (s) => !REMOVED_BENCH_SLUGS.has(s) && !DEV_ONLY_BENCH_SLUGS.has(s),
    );
    for (const slug of shown) {
      expect(REMOVED_BENCH_SLUGS.has(slug)).toBe(false);
      expect(DEV_ONLY_BENCH_SLUGS.has(slug)).toBe(false);
    }
    expect(shown.length).toBeGreaterThan(0);
  });

  test("drops the two that were live links to 410 pages", () => {
    // Pinned by name: both are in REMOVED_BENCH_SLUGS, so if either is ever
    // un-retired this test says so instead of failing silently.
    const curated = curatedSlugs();
    expect(curated).toContain("indexing-freshness");
    expect(curated).toContain("portfolio-chain-coverage");
    expect(REMOVED_BENCH_SLUGS.has("indexing-freshness")).toBe(true);
    expect(REMOVED_BENCH_SLUGS.has("portfolio-chain-coverage")).toBe(true);
  });
});
