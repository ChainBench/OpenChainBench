import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The category hubs in the sitemap must apply the same "does this build
 * serve the bench" gate as the bench routes. The worker publishes from dev,
 * so production's blob carries benches production does not serve; a
 * category whose only bench is one of them 404s on production while its URL
 * sits in the sitemap. That happened to /benchmarks/category/wallets the day
 * bench 309 landed on dev (audit 2026-10-29), years after the bench routes
 * got the gate for arc-rpc and robinhood-rpc.
 *
 * A source test, because the builder reads the live blob and specs; the
 * failure it guards against is a missing clause, visible in the source.
 */
describe("sitemap category hubs", () => {
  test("are built only from benches this build serves", () => {
    const src = readFileSync(join(import.meta.dir, "sitemap-builder.ts"), "utf8");
    const decl = src.match(/const activeBlobBenches = blobBenches\.filter\(([\s\S]*?)\);/);
    expect(decl).not.toBeNull();
    const body = decl![1];
    expect(body).toContain("servedSlugs.has(b.slug)");
    expect(body).toContain("isDevOnlyBench(b.slug)");
    expect(body).toContain("REMOVED_BENCH_SLUGS.has(b.slug)");
    // and the hubs read that filtered list
    expect(src).toMatch(/liveCategoryLabels = new Set\(activeBlobBenches\.map/);
  });
});

describe("bench index for navigation", () => {
  // The related-benches rail reads getBenchIndexSafe; on production it
  // linked /benchmarks/wallet-cost to the gated bench 310, a 404 (SEO audit
  // 2026-10-30).
  test("drops benches this build does not serve", () => {
    const src = readFileSync(join(import.meta.dir, "../data/benchmarks.ts"), "utf8");
    const decl = src.match(/export const getBenchIndexSafe = cache\(async \(\)[\s\S]*?\n\}\);/);
    expect(decl).not.toBeNull();
    expect(decl![0]).toContain("isDevOnlyBench(b.slug)");
  });
});
