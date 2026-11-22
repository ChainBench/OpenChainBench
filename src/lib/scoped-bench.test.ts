import { describe, expect, mock, test } from "bun:test";
import { perpFeesBoard } from "@/test/benchmark";
import type { ProviderResult, ProviderVenueType } from "@/types/benchmark";

const row = (slug: string, venueType: ProviderVenueType): ProviderResult => ({
  name: slug,
  slug,
  venueType,
  ms: { p50: 5, p90: 5, p99: 5, mean: 5 },
  successRate: 1,
});

const board = perpFeesBoard({
  results: [row("hyperliquid", "dex"), row("binance", "cex")],
});

const actualSpec = { ...(await import("@/lib/spec")) };
mock.module("@/lib/spec", () => ({
  ...actualSpec,
  loadBenchmark: async () => board,
}));

const { loadAnswer } = await import("./answers");
const { loadAlternative } = await import("./alternatives");
const { loadScopedBench } = await import("./scoped-bench");

const slugs = (b: { results: ProviderResult[] } | undefined) =>
  b?.results.map((r) => r.slug);

describe("DEX-only pages on perp-fees", () => {
  test("the lowest-fees answer ranks no CEX row", async () => {
    const ans = await loadAnswer("which-perp-dex-has-the-lowest-fees");
    expect(slugs(ans?.bench)).toEqual(["hyperliquid"]);
  });

  test("the GMX alternative ranks no CEX row", async () => {
    const alt = await loadAlternative("gmx");
    expect(slugs(alt?.bench)).toEqual(["hyperliquid"]);
  });

  test("a page without a venue type keeps every row", async () => {
    const bench = await loadScopedBench({ benchmark: "perp-fees" });
    expect(slugs(bench)).toEqual(["hyperliquid", "binance"]);
  });
});
