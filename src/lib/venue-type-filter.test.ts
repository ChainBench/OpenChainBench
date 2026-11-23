import { describe, expect, test } from "bun:test";
import { leader } from "./citation";
import { overlayEditorial } from "./spec";
import { SpecSchema } from "./spec-schema";
import {
  parseVenueTypeView,
  scopeFromParams,
  scopeNote,
  scopeToVenueType,
  shownVenueTypeView,
  venueTypeCounts,
  type VenueTypeView,
} from "./venue-type-filter";
import {
  perpFeesBoard,
  perpFeesRow as row,
  perpFeesSpecRaw,
} from "@/test/benchmark";

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
});

test.each([
  ["venue_type=dex", "dex", "hyperliquid", " (DEX venues only)"],
  ["", "dex", "binance", ""],
  ["venue_type=cex", undefined, "binance", ""],
])("a card for %p on a %p board leads with %p", (query, type, want, note) => {
  const board = perpFeesBoard({
    results: [
      row("hyperliquid", type === "dex" ? "dex" : undefined, 5),
      row("binance", type === "dex" ? "cex" : undefined, 1),
    ],
  });
  const { view, bench } = scopeFromParams(board, new URLSearchParams(query));
  expect(leader(bench)?.slug).toBe(want);
  expect(scopeNote(view)).toBe(note);
});

test.each<[string | null, VenueTypeView]>([
  ["dex", "dex"],
  ["spot", "all"],
])("parseVenueTypeView(%p) is %p", (raw, view) => {
  expect(parseVenueTypeView(raw)).toBe(view);
});

test.each<[VenueTypeView, number, VenueTypeView]>([
  ["dex", 2, "dex"],
  ["dex", 0, "all"],
])(
  "a %p pick on a board with %p typed rows shows %p",
  (picked, typed, want) => {
    const counts = { all: 3, dex: typed, cex: 0 };
    expect(shownVenueTypeView(picked, counts)).toBe(want);
  },
);

test.each<[VenueTypeView | undefined, string | undefined, string]>([
  ["all", undefined, ""],
  ["dex", "Solana", " (filtered to Solana, DEX venues only)"],
])("scopeNote(%p, %p) is %p", (view, chain, note) => {
  expect(scopeNote(view, chain)).toBe(note);
});
