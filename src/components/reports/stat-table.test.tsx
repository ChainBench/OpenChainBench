import { afterAll, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
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
afterAll(() => mock.restore());

const { StatTable } = await import("./stat-table");

test("a DEX report table lists no CEX row", async () => {
  const html = renderToStaticMarkup(
    await StatTable({ bench: "perp-fees", venueType: "dex" }),
  );
  expect(html).toContain("hyperliquid");
  expect(html).not.toContain("binance");
});
