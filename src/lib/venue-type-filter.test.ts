import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { overlayEditorial } from "./spec";
import { SpecSchema } from "./spec-schema";
import { scopeToVenueType, venueTypeCounts } from "./venue-type-filter";
import { perpFeesBoard } from "@/test/benchmark";
import type { ProviderResult } from "@/types/benchmark";

const row = (slug: string): ProviderResult => ({
  name: slug,
  slug,
  ms: { p50: 5, p90: 5, p99: 5, mean: 5 },
  successRate: 1,
});

const perpFeesSpec = () =>
  SpecSchema.parse(
    yaml.load(
      readFileSync(join(process.cwd(), "benchmarks/perp-fees.yml"), "utf8"),
    ),
  );

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
