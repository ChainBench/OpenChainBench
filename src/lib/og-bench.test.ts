import { expect, mock, test } from "bun:test";
import { leader } from "@/lib/citation";
import { perpFeesBoard, perpFeesRow } from "@/test/benchmark";

const board = perpFeesBoard({
  results: [
    perpFeesRow("hyperliquid", "dex", 5),
    perpFeesRow("binance", "cex", 1),
  ],
});

const actualData = { ...(await import("@/data/benchmarks")) };
mock.module("@/data/benchmarks", () => ({
  ...actualData,
  getBenchmark: async () => board,
}));

const { loadOgBench } = await import("./og-bench");

test.each([
  ["dex", "hyperliquid"],
  [null, "binance"],
])("the OG image scoped to %p leads with %p", async (raw, want) => {
  const { bench } = await loadOgBench("perp-fees", raw);
  expect(bench ? leader(bench)?.slug : undefined).toBe(want);
});
