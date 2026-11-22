import { afterAll, describe, expect, mock, test } from "bun:test";
import { perpFeesBoard, perpFeesRow } from "@/test/benchmark";
import type { ProviderResult } from "@/types/benchmark";

const board = perpFeesBoard({
  results: [
    { ...perpFeesRow("hyperliquid", "dex"), sampleSize: 7 },
    perpFeesRow("binance", "cex"),
  ],
  sampleSize: 99,
});

mock.module("next/cache", () => ({
  unstable_cache: <T,>(fn: T) => fn,
}));
const actualSpec = { ...(await import("@/lib/spec")) };
mock.module("@/lib/spec", () => ({
  ...actualSpec,
  loadBenchmark: async (slug: string) =>
    slug === "perp-fees" ? board : undefined,
}));
const actualData = { ...(await import("@/data/benchmarks")) };
mock.module("@/data/benchmarks", () => ({
  ...actualData,
  getBenchmarks: async () => [board],
}));
afterAll(() => mock.restore());

const { loadAllAnswers, loadAnswer } = await import("./answers");
const { loadAllAlternatives, loadAlternative } = await import("./alternatives");
const { loadRenderedAnswers } = await import("./answers-rendered");
const { loadScopedBench } = await import("./scoped-bench");
const { getAlternativesFeaturing } = await import("./related-providers");
const answerPage = await import("@/app/answers/[slug]/page");
const alternativePage = await import("@/app/alternatives/[slug]/page");
const citable = await import("@/app/api/citable/route");

const slugs = (b: { results: ProviderResult[] } | undefined) =>
  b?.results.map((r) => r.slug);

const onPerpFees = (p: { benchmark: string; slug: string }) =>
  p.benchmark === "perp-fees" ? [p.slug] : [];
const answerSlugs = (await loadAllAnswers()).flatMap(onPerpFees);
const alternativeSlugs = (await loadAllAlternatives()).flatMap(onPerpFees);

describe("DEX-only pages on perp-fees", () => {
  test("every perp-fees page is checked", () => {
    expect(answerSlugs.length).toBeGreaterThan(0);
    expect(alternativeSlugs.length).toBeGreaterThan(0);
  });

  test.each(answerSlugs)("answer %s ranks no CEX row", async (slug) => {
    const ans = await loadAnswer(slug);
    expect(slugs(ans?.bench)).toEqual(["hyperliquid"]);
  });

  test.each(alternativeSlugs)(
    "alternative %s ranks no CEX row",
    async (slug) => {
      const alt = await loadAlternative(slug);
      expect(slugs(alt?.bench)).toEqual(["hyperliquid"]);
    },
  );

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
    expect(bench?.sampleSize).toBe(7);
  });

  test.each([
    ...answerSlugs.map((slug) => [slug, answerPage] as const),
    ...alternativeSlugs.map((slug) => [slug, alternativePage] as const),
  ])("%s shares the DEX-scoped image", async (slug, page) => {
    const meta = await page.generateMetadata({
      params: Promise.resolve({ slug }),
    });
    expect(JSON.stringify(meta.twitter)).toContain(
      "/api/og/perp-fees?venue_type=dex",
    );
  });

  test("citable answers link to the DEX-scoped board", async () => {
    const res = await citable.GET(
      new Request("https://openchainbench.com/api/citable"),
    );
    const body: { answers: { benchmark: string; benchmarkUrl: string }[] } =
      await res.json();
    const perp = body.answers.filter((a) => a.benchmark === "perp-fees");
    expect(perp.map((a) => a.benchmarkUrl)).toEqual(
      answerSlugs.map(() => expect.stringContaining("?venue_type=dex")),
    );
  });

  test("a CEX is listed on no DEX-only alternatives page", async () => {
    const featured = async (provider: string) =>
      (await getAlternativesFeaturing(provider)).map((f) => f.slug);
    expect(await featured("binance")).toEqual([]);
    expect(await featured("hyperliquid")).not.toEqual([]);
  });

  test("a page without a venue type keeps every row", async () => {
    const bench = await loadScopedBench({ benchmark: "perp-fees" });
    expect(slugs(bench)).toEqual(["hyperliquid", "binance"]);
    expect(bench?.sampleSize).toBe(99);
  });
});
