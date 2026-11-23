import { expect, test } from "bun:test";
import {
  sortPerpRowsByFunding,
  type PerpAssetVenueRow,
} from "./perp-asset-pages";

const cexRow = (
  slug: string,
  allInBps: number,
  funding24hBps: number | null,
): PerpAssetVenueRow => ({
  slug,
  name: slug,
  productSlug: slug,
  venueType: "cex",
  allInBps,
  takerFeeBps: null,
  slippage100kBps: null,
  slippage100kFill: null,
  funding24hBps,
  funding7dBps: null,
  funding30dBps: null,
  funding30dSamples: null,
});

test("CEX rows sort by funding even when they carry an all-in cost", () => {
  const rows = [
    cexRow("binance", 4, 3),
    cexRow("okx", 9, null),
    cexRow("bybit", 6, -1),
  ];
  expect(sortPerpRowsByFunding(rows).map((r) => r.slug)).toEqual([
    "bybit",
    "binance",
    "okx",
  ]);
});
