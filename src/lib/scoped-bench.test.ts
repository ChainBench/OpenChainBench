import { describe, expect, mock, test } from "bun:test";
import { perpFeesBoard } from "@/test/benchmark";
import type { ProviderResult, ProviderVenueType } from "@/types/benchmark";

const row = (slug: string, venueType: ProviderVenueType): ProviderResult => ({
  name: slug,
  slug,
  venueType,
  ms: { p50: 5, p90: 5, p99: 5, mean: 5 },
  successRate: 1,
  sampleSize: 10,
});

const board = perpFeesBoard({
  results: [row("hyperliquid", "dex"), row("binance", "cex")],
  sampleSize: 20,
});

const actualSpec = { ...(await import("@/lib/spec")) };
mock.module("@/lib/spec", () => ({
  ...actualSpec,
  loadBenchmark: async () => board,
}));

const { loadAllAnswers, loadAnswer } = await import("./answers");
const { loadAllAlternatives, loadAlternative } = await import("./alternatives");
const { loadRenderedAnswers } = await import("./answers-rendered");
const { loadScopedBench } = await import("./scoped-bench");

const slugs = (b: { results: ProviderResult[] } | undefined) =>
  b?.results.map((r) => r.slug);

const onPerpFees = (p: { benchmark: string; slug: string }) =>
  p.benchmark === "perp-fees" ? [p.slug] : [];
const answerSlugs = (await loadAllAnswers()).flatMap(onPerpFees);
const alternativeSlugs = (await loadAllAlternatives()).flatMap(onPerpFees);

describe("DEX-only pages on perp-fees", () => {
  test.each(answerSlugs)("answer %s ranks no CEX row", async (slug) => {
    const ans = await loadAnswer(slug);
    expect(slugs(ans?.bench)).toEqual(["hyperliquid"]);
  });

  test.each(alternativeSlugs)("alternative %s ranks no CEX row", async (slug) => {
    const alt = await loadAlternative(slug);
    expect(slugs(alt?.bench)).toEqual(["hyperliquid"]);
  });

  test("the rendered answers rank no CEX row", async () => {
    const rendered = (await loadRenderedAnswers()).filter(
      (a) => a.benchmark === "perp-fees",
    );
    expect(rendered.map((a) => slugs(a.bench))).toEqual(
      answerSlugs.map(() => ["hyperliquid"]),
    );
  });

  test("a scoped page counts only its own samples", async () => {
    const bench = await loadScopedBench({
      benchmark: "perp-fees",
      venue_type: "dex",
    });
    expect(bench?.sampleSize).toBe(10);
  });

  test("a page without a venue type keeps every row", async () => {
    const bench = await loadScopedBench({ benchmark: "perp-fees" });
    expect(slugs(bench)).toEqual(["hyperliquid", "binance"]);
  });
});
