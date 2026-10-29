import { describe, expect, test } from "bun:test";
import { panelSeriesCacheKey } from "@/components/time-series-chart/scales";

/**
 * The chart caches a panel's lazily fetched 7d/30d/90d/1y series, and the key
 * decides whether switching a tab refetches.
 *
 * Keyed on the panel id alone, it did not. The effects re-ran on a chain
 * change, hit their own "already cached?" guard, and returned before
 * fetching, so the first chain a reader opened stayed on screen for every
 * other chain. On bench 001 that put one chain's First to report shares on
 * four tabs and named the wrong leader on three of them (Base is Serialized
 * at 74.7 %, BNB is Mobula at 64.8 %, Robinhood is Serialized at 93.3 %;
 * only Solana was Codex). 1H/6H/24H were always right because they render
 * from the embedded per-filter series, which is exactly why the report was
 * "only 7D and 30D".
 *
 * So the property under test is simply: two different filter sets must never
 * share a key.
 */
describe("panelSeriesCacheKey", () => {
  test("a chain change produces a different key", () => {
    expect(panelSeriesCacheKey("first_share", "base")).not.toBe(
      panelSeriesCacheKey("first_share", "bnb"),
    );
  });

  test("a region change produces a different key", () => {
    expect(panelSeriesCacheKey("first_share", "base", "eu-west")).not.toBe(
      panelSeriesCacheKey("first_share", "base", "sgp"),
    );
  });

  test("a tier change produces a different key", () => {
    expect(panelSeriesCacheKey("p50", "ethereum", "eu-west", "keyed")).not.toBe(
      panelSeriesCacheKey("p50", "ethereum", "eu-west", "public"),
    );
  });

  test("a panel change still produces a different key", () => {
    expect(panelSeriesCacheKey("first_share", "base")).not.toBe(
      panelSeriesCacheKey("head_lag", "base"),
    );
  });

  test("the same filters produce the same key, so the cache still works", () => {
    expect(panelSeriesCacheKey("first_share", "base", "eu-west", "public")).toBe(
      panelSeriesCacheKey("first_share", "base", "eu-west", "public"),
    );
  });

  test("an absent filter is distinct from a present one", () => {
    // The unfiltered view and a chain tab must not share an entry either.
    expect(panelSeriesCacheKey("first_share")).not.toBe(
      panelSeriesCacheKey("first_share", "base"),
    );
  });

  test("filters cannot collide across positions", () => {
    // A naive concatenation would make (chain=a, region=b) equal to
    // (chain=ab) and serve one tab's series on another.
    expect(panelSeriesCacheKey("p", "a", "b")).not.toBe(panelSeriesCacheKey("p", "ab"));
    expect(panelSeriesCacheKey("p", "", "x")).not.toBe(panelSeriesCacheKey("p", "x", ""));
  });
});
