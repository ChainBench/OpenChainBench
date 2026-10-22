import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { benchRowsForVenue } from "./perp-venue-context";
import {
  MARKET_COUNT_NOT_COMPARABLE,
  PERP_VENUES,
  type PerpCohortSummary,
  type PerpVenueRow,
} from "./perp-stats";

/**
 * Nova and Gains ship the identical 493-pair gTrade registry. gTrade delists a
 * pair by setting its max leverage override to 0.001x rather than removing it:
 * Gains carries that override on 315 pairs and counts 178, Nova carries it on
 * none (read 2026-10-22). So the two counts are not the same measurement, and
 * ranking them together publishes "Nova lists 2.8x the markets of Gains" off
 * one list.
 *
 * bench 116 carries the row with `unranked: Registry unpruned`. The product
 * page's Active markets card computes its own rank from the cohort, so the two
 * can disagree silently. These pin them together. The CEX exclusion in the
 * same function is the precedent: Binance's pair count once outranked every
 * DEX on a card linking to a bench that lists no CEX.
 */
function row(
  slug: string,
  activeMarkets: number | null,
  venueType: PerpVenueRow["venueType"] = "onchain",
): PerpVenueRow {
  return {
    slug,
    name: slug[0].toUpperCase() + slug.slice(1),
    chain: "x",
    venueType,
    volume24h: null,
    volume30d: null,
    openInterest: null,
    fees30d: null,
    activeMarkets,
    topMarketVolume24h: null,
    health: null,
  } as PerpVenueRow;
}

const VENUES = [
  row("aster", 604),
  row("nova", 493),
  row("extended", 334),
  row("gains", 178),
  row("binance", 1200, "cex"),
];
const cohort = { venues: VENUES } as PerpCohortSummary;

function marketCard(slug: string) {
  const venue = VENUES.find((v) => v.slug === slug)!;
  return benchRowsForVenue(cohort, venue).find(
    (r) => r.benchSlug === "perp-active-markets",
  )!;
}

describe("the Active markets card does not rank an unpruned registry", () => {
  test("Nova's card shows the count and no rank", () => {
    const card = marketCard("nova");
    expect(card.value).toBe("493");
    expect(card.rank).toBeNull();
  });

  test("Nova does not push the venues below it down a place", () => {
    // The bug this prevents: Gains reading "4th of 4" because a row the
    // bench refuses to rank sits above it.
    expect(marketCard("aster").rank).toBe(1);
    expect(marketCard("extended").rank).toBe(2);
    expect(marketCard("gains").rank).toBe(3);
  });

  test("the cohort size counts only the venues actually ranked", () => {
    expect(marketCard("gains").cohortSize).toBe(3);
  });

  test("the CEX reference stays excluded as well", () => {
    // Already true before Nova; pinned so the new filter did not replace it.
    expect(marketCard("binance").rank).toBeNull();
  });
});

describe("the exclusion agrees with the bench spec", () => {
  const spec = load(
    readFileSync(
      join(import.meta.dir, "../../benchmarks/perp-active-markets.yml"),
      "utf8",
    ),
  ) as { providers: { slug: string; unranked?: string }[] };

  test("every venue this set excludes is unranked on bench 116", () => {
    // Two places encode the same judgement. A provider un-unranked in the
    // spec while still in this set would publish a ranked row on the bench
    // and a blank rank on the product page, from the same number.
    for (const slug of MARKET_COUNT_NOT_COMPARABLE) {
      const p = spec.providers.find((x) => x.slug === slug);
      expect(p, `${slug} is in the set but not a provider on bench 116`).toBeDefined();
      expect(p!.unranked, `${slug} is ranked on bench 116`).toBeTruthy();
    }
  });

  test("and is a venue the hub actually knows", () => {
    for (const slug of MARKET_COUNT_NOT_COMPARABLE) {
      expect(PERP_VENUES.some((v) => v.slug === slug)).toBe(true);
    }
  });
});
