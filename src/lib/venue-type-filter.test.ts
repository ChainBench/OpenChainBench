import { describe, expect, test } from "bun:test";
import { overlayEditorial } from "./spec";
import { SpecSchema } from "./spec-schema";
import {
  parseVenueTypeView,
  scopeToVenueType,
  venueTypeCounts,
  type VenueTypeView,
} from "./venue-type-filter";
import { perpFeesBoard, perpFeesSpecRaw } from "@/test/benchmark";
import type { ProviderResult } from "@/types/benchmark";

const row = (slug: string): ProviderResult => ({
  name: slug,
  slug,
  ms: { p50: 5, p90: 5, p99: 5, mean: 5 },
  successRate: 1,
});

const perpFeesSpec = () => SpecSchema.parse(perpFeesSpecRaw());

describe("venue type on a stored board", () => {
  const stored = perpFeesBoard({
    results: [row("hyperliquid"), row("lighter"), row("binance")],
  });
  const board = overlayEditorial(stored, perpFeesSpec());

  test("rows written without a type take it from the live spec", () => {
    expect(venueTypeCounts(board.results)).toEqual({ all: 3, dex: 2, cex: 1 });
  });

  test("a DEX scope keeps no CEX row", () => {
    const slugs = scopeToVenueType(board, "dex")?.results.map((r) => r.slug);
    expect(slugs).toEqual(["hyperliquid", "lighter"]);
  });
});

test("a row without a type stays out of a typed scope", () => {
  const board = perpFeesBoard({ results: [row("unlisted")] });
  expect(venueTypeCounts(board.results)).toEqual({ all: 1, dex: 0, cex: 0 });
  expect(scopeToVenueType(board, "dex")?.results).toEqual([]);
  expect(scopeToVenueType(board, "all")?.results).toHaveLength(1);
});

test.each<[string | null, VenueTypeView]>([
  ["dex", "dex"],
  ["cex", "cex"],
  ["all", "all"],
  [null, "all"],
  ["DEX", "all"],
  ["", "all"],
])("parseVenueTypeView(%p) is %p", (raw, view) => {
  expect(parseVenueTypeView(raw)).toBe(view);
});

